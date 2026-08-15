import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { closeDatabase, getDatabase } from "../src/lib/db";
import {
  getPersonaEvidence,
  groundStudyPersonasFromEvidence,
  updatePersonaRetention,
} from "../src/lib/persona-evidence";
import { listPersonas, updatePersona } from "../src/lib/studies";
import { createSmokePlanVersion } from "./smoke-plan-fixture";

if (process.env.PERSONA_EVIDENCE_SMOKE_CONFIRM !== "1") {
  throw new Error("Set PERSONA_EVIDENCE_SMOKE_CONFIRM=1 to run the isolated database smoke test.");
}
const databaseUrl = new URL(process.env.DATABASE_URL ?? "");
if (!["localhost", "127.0.0.1"].includes(databaseUrl.hostname)) {
  throw new Error("Persona evidence smoke test only runs against a local database.");
}

const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
const authUserId = randomUUID();
let workspaceId: string | null = null;

const profile = {
  name: "稳定通勤者",
  archetype: "直达优先",
  age: 34,
  city: "上海",
  occupation: "产品经理",
  commute: "工作日公共交通通勤",
  budget: "中等",
  currentSituation: "雨天会重新评估路线并优先减少换乘。",
  goals: ["稳定到达", "减少换乘"],
  painPoints: ["换乘不确定", "雨天拥堵"],
  decisionStyle: "先比较直达性，再比较预计到达时间。",
  tags: ["通勤", "公交"],
};

async function main() {
  const database = await getDatabase();
  try {
    const seeded = await database.transaction(async (transaction) => {
      await transaction.query(
        `insert into auth.users (id, email, raw_user_meta_data)
         values ($1, $2, '{"display_name":"Persona evidence smoke"}'::jsonb)`,
        [authUserId, `persona-evidence-${suffix}@example.com`],
      );
      const actor = await transaction.query<{
        user_id: string; user_public_id: string; workspace_id: string; workspace_public_id: string;
      }>(
        `select app_user.id::text as user_id, app_user.public_id as user_public_id,
                workspace.id::text as workspace_id, workspace.public_id as workspace_public_id
         from users app_user
         join workspace_members member on member.user_id = app_user.id
         join workspaces workspace on workspace.id = member.workspace_id
         where app_user.auth_user_id = $1`,
        [authUserId],
      );
      workspaceId = actor.rows[0].workspace_id;
      const study = await transaction.query<{ id: string }>(
        `insert into studies (public_id, workspace_id, created_by, title, brief, status, current_stage)
         values ($1, $2, $3, 'Persona evidence smoke', '验证 Persona 证据与保留门禁', 'completed', 'report')
         returning id::text as id`,
        [`std_${suffix}`, workspaceId, actor.rows[0].user_id],
      );
      const planVersion = await createSmokePlanVersion(transaction, study.rows[0].id, actor.rows[0].user_id);
      const run = await transaction.query<{ id: string }>(
        `insert into study_runs (public_id, study_id, plan_version_id, status, provider, provider_model, finished_at)
         values ($1, $2, $3, 'completed', 'smoke', 'smoke-model', now()) returning id::text as id`,
        [`run_${suffix}`, study.rows[0].id, planVersion.id],
      );
      const persona = await transaction.query<{ id: string; public_id: string }>(
        `insert into study_personas (
           public_id, workspace_id, created_by, study_id, run_id, name, archetype,
           profile, source, visibility, retention_status
         ) values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, 'generated', 'workspace', 'pending')
         returning id::text as id, public_id`,
        [`per_${suffix}`, workspaceId, actor.rows[0].user_id, study.rows[0].id, run.rows[0].id, profile.name, profile.archetype, JSON.stringify(profile)],
      );
      const unrelatedPersona = await transaction.query<{ id: string; public_id: string }>(
        `insert into study_personas (
           public_id, workspace_id, created_by, study_id, run_id, name, archetype,
           profile, source, visibility, retention_status
         ) values ($1, $2, $3, $4, $5, '其他画像', '无关样本', $6::jsonb, 'generated', 'workspace', 'pending')
         returning id::text as id, public_id`,
        [`per_other_${suffix}`, workspaceId, actor.rows[0].user_id, study.rows[0].id, run.rows[0].id, JSON.stringify({ ...profile, name: "其他画像", archetype: "无关样本" })],
      );
      const source = await transaction.query<{ id: string }>(
        `insert into evidence_sources (
           public_id, workspace_id, study_id, run_id, source_type, title,
           source_locator, content_hash, metadata
         ) values ($1, $2, $3, $4, 'synthetic_interview', 'AI 合成访谈 · 稳定通勤者',
                   $5::jsonb, $6, '{"disclaimer":"synthetic"}'::jsonb)
         returning id::text as id`,
        [`evs_${suffix}`, workspaceId, study.rows[0].id, run.rows[0].id, JSON.stringify({ personaName: profile.name }), suffix.padEnd(64, "0")],
      );
      const evidenceIds: string[] = [];
      for (const [index, content] of ["雨天优先选择直达公交。", "换乘次数比理论最短时间更重要。"].entries()) {
        const evidence = await transaction.query<{ id: string }>(
          `insert into evidence_items (
             public_id, source_id, item_key, evidence_type, content, locator, metadata
           ) values ($1, $2, $3, 'synthetic_simulation', $4, $5::jsonb, '{}'::jsonb)
           returning id::text as id`,
          [`evi_${index}_${suffix}`, source.rows[0].id, `synthetic-${String(index + 1).padStart(2, "0")}`, content, JSON.stringify({ personaName: profile.name, batch: index + 1 })],
        );
        evidenceIds.push(evidence.rows[0].id);
      }
      const unrelatedEvidence = await transaction.query<{ id: string; public_id: string }>(
        `insert into evidence_items (
           public_id, source_id, item_key, evidence_type, content, locator, metadata
         ) values ($1, $2, 'synthetic-99', 'synthetic_simulation', '无关 Persona 的表达',
                   '{"personaName":"不存在的画像"}'::jsonb, '{}'::jsonb)
         returning id::text as id, public_id`,
        [`evi_other_${suffix}`, source.rows[0].id],
      );
      const claim = await transaction.query<{ id: string }>(
        `insert into claims (
           public_id, workspace_id, study_id, run_id, claim_key, statement,
           claim_type, confidence, support_status, rationale
         ) values ($1, $2, $3, $4, 'finding-1', '雨天通勤时直达性是重要决策条件',
                   'synthetic_simulation', 'medium', 'supported', '两轮合成访谈一致')
         returning id::text as id`,
        [`clm_${suffix}`, workspaceId, study.rows[0].id, run.rows[0].id],
      );
      for (const evidenceId of evidenceIds) {
        await transaction.query(
          `insert into claim_evidence (claim_id, evidence_item_id, stance, strength, rationale)
           values ($1, $2, 'supports', 'medium', 'smoke')`,
          [claim.rows[0].id, evidenceId],
        );
      }
      return {
        actor: actor.rows[0],
        studyId: study.rows[0].id,
        runId: run.rows[0].id,
        personaId: persona.rows[0].id,
        personaPublicId: persona.rows[0].public_id,
        unrelatedPersonaPublicId: unrelatedPersona.rows[0].public_id,
        unrelatedEvidenceId: unrelatedEvidence.rows[0].id,
        unrelatedEvidencePublicId: unrelatedEvidence.rows[0].public_id,
      };
    });
    const viewer = {
      userId: seeded.actor.user_id,
      userPublicId: seeded.actor.user_public_id,
      displayName: "Persona evidence smoke",
      email: `persona-evidence-${suffix}@example.com`,
      workspaceId: seeded.actor.workspace_id,
      workspacePublicId: seeded.actor.workspace_public_id,
      workspaceName: "Persona evidence smoke",
      role: "owner" as const,
      tokenBalance: 0,
    };

    const firstGrounding = await database.transaction((transaction) => groundStudyPersonasFromEvidence(transaction, {
      workspaceId: viewer.workspaceId,
      studyId: seeded.studyId,
      runId: seeded.runId,
      personas: [
        { publicId: seeded.personaPublicId, name: profile.name },
        { publicId: seeded.unrelatedPersonaPublicId, name: "其他画像" },
      ],
    }));
    assert.deepEqual(firstGrounding, { grounded: 1, unsupported: 1, links: 2 });
    const repeatedGrounding = await database.transaction((transaction) => groundStudyPersonasFromEvidence(transaction, {
      workspaceId: viewer.workspaceId,
      studyId: seeded.studyId,
      runId: seeded.runId,
      personas: [{ publicId: seeded.personaPublicId, name: profile.name }],
    }));
    assert.deepEqual(repeatedGrounding, { grounded: 1, unsupported: 0, links: 2 });

    const inactiveLibrary = await listPersonas(viewer, { includeInactive: true });
    const groundedPersona = inactiveLibrary.personas.find((persona) => persona.publicId === seeded.personaPublicId);
    assert(groundedPersona);
    assert.equal(groundedPersona.evidenceStatus, "synthetic_grounded");
    assert.equal(groundedPersona.evidenceConfidence, "medium");
    assert.equal(groundedPersona.groundingSummary.evidenceCount, 2);
    assert.equal(groundedPersona.groundingSummary.claimCount, 1);
    assert.equal((await listPersonas(viewer)).personas.some((persona) => persona.publicId === seeded.personaPublicId), false);

    const detail = await getPersonaEvidence(viewer, seeded.personaPublicId);
    assert.notEqual(detail, "not_found");
    if (detail === "not_found") throw new Error("PERSONA_EVIDENCE_DETAIL_MISSING");
    assert.equal(detail.evidence.length, 2);
    assert(detail.evidence.every((evidence) => evidence.claims[0]?.statement.includes("直达性")));
    assert(!detail.evidence.some((evidence) => evidence.publicId === seeded.unrelatedEvidencePublicId));

    const retained = await updatePersonaRetention(viewer, seeded.personaPublicId, {
      retentionStatus: "retained",
      validUntil: "2027-08-15T23:59:59.000Z",
      note: "证据范围已复核，保留一年",
    });
    assert.equal(typeof retained, "object");
    assert((await listPersonas(viewer)).personas.some((persona) => persona.publicId === seeded.personaPublicId));

    const updated = await updatePersona(viewer, seeded.personaPublicId, {
      ...profile,
      currentSituation: "雨天会重新评估路线，并记录延误与换乘风险。",
      visibility: "workspace",
      addToPanelPublicIds: [],
    });
    assert.equal(updated, "updated");
    const invalidated = await getPersonaEvidence(viewer, seeded.personaPublicId);
    assert.notEqual(invalidated, "not_found");
    if (invalidated === "not_found") throw new Error("PERSONA_INVALIDATION_MISSING");
    assert.equal(invalidated.evidenceStatus, "ungrounded");
    assert.equal(invalidated.evidence.length, 0);

    await database.transaction((transaction) => groundStudyPersonasFromEvidence(transaction, {
      workspaceId: viewer.workspaceId,
      studyId: seeded.studyId,
      runId: seeded.runId,
      personas: [{ publicId: seeded.personaPublicId, name: profile.name }],
    }));
    await database.query("update study_personas set valid_until = now() - interval '1 day' where id = $1", [seeded.personaId]);
    assert.equal((await listPersonas(viewer)).personas.some((persona) => persona.publicId === seeded.personaPublicId), false);
    const expired = await getPersonaEvidence(viewer, seeded.personaPublicId);
    assert.notEqual(expired, "not_found");
    if (expired === "not_found") throw new Error("PERSONA_EXPIRY_MISSING");
    assert.equal(expired.retentionStatus, "expired");

    const retired = await updatePersonaRetention(viewer, seeded.personaPublicId, {
      retentionStatus: "retired",
      validUntil: null,
      note: "样本已过期，停止后续复用",
    });
    assert.equal(typeof retired, "object");
    const counts = await database.query<{ links: number; events: number; unrelated_links: number }>(
      `select
         (select count(*)::int from persona_evidence_links where persona_id = $1) as links,
         (select count(*)::int from persona_governance_events where persona_id = $1) as events,
         (select count(*)::int from persona_evidence_links where evidence_item_id = $2) as unrelated_links`,
      [seeded.personaId, seeded.unrelatedEvidenceId],
    );
    assert.deepEqual(counts.rows[0], { links: 2, events: 5, unrelated_links: 0 });

    console.log(JSON.stringify({
      preciseEvidenceLinks: counts.rows[0].links,
      unrelatedEvidenceExcluded: true,
      pendingReuseBlocked: true,
      retainedReuseEnabled: true,
      editInvalidatedGrounding: true,
      expiredReuseBlocked: true,
      retiredReuseBlocked: true,
      governanceEvents: counts.rows[0].events,
      repeatedGroundingEventIdempotent: true,
    }, null, 2));
  } finally {
    if (workspaceId) await database.query("delete from workspaces where id = $1", [workspaceId]);
    await database.query("delete from auth.users where id = $1", [authUserId]);
    await closeDatabase();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
