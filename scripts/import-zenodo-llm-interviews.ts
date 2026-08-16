import { createHash } from "node:crypto";
import { createContextAsset } from "../src/lib/context-system";
import { closeDatabase, getDatabase } from "../src/lib/db";
import type { Viewer } from "../src/lib/auth";

const RECORD_ID = "17484327";
const RECORD_URL = `https://zenodo.org/api/records/${RECORD_ID}`;
const DOI = "10.5281/zenodo.17484327";
const FILE_PATTERN = /^interview_p([1-9]|1\d|20)_en\.txt$/;
const PII_PATTERN = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|\+?[0-9][0-9 ()-]{7,}[0-9]|https?:\/\//i;

type ZenodoFile = {
  key: string;
  checksum: string;
  size: number;
  links: { self: string };
};

type ZenodoRecord = {
  metadata: {
    access_right: string;
    license?: { id?: string };
    description: string;
    title: string;
  };
  files: ZenodoFile[];
};

function fileNumber(file: ZenodoFile) {
  return Number(file.key.match(FILE_PATTERN)?.[1] ?? 0);
}

function md5(value: string) {
  return createHash("md5").update(value).digest("hex");
}

async function fetchJson(url: string) {
  const response = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`ZENODO_METADATA_FETCH_FAILED:${response.status}`);
  return response.json() as Promise<ZenodoRecord>;
}

async function fetchTranscript(file: ZenodoFile) {
  const response = await fetch(file.links.self, { headers: { accept: "*/*" }, signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`ZENODO_FILE_FETCH_FAILED:${file.key}:${response.status}`);
  const content = await response.text();
  if (!content.trim() || content.length > 50_000) throw new Error(`ZENODO_FILE_SIZE_INVALID:${file.key}`);
  if (Buffer.byteLength(content) !== file.size) throw new Error(`ZENODO_FILE_SIZE_MISMATCH:${file.key}`);
  if (PII_PATTERN.test(content)) throw new Error(`ZENODO_PII_PATTERN_DETECTED:${file.key}`);
  const expectedChecksum = file.checksum.replace(/^md5:/, "").toLowerCase();
  if (md5(content) !== expectedChecksum) throw new Error(`ZENODO_CHECKSUM_MISMATCH:${file.key}`);
  return content;
}

async function loadViewer(workspacePublicId: string): Promise<Viewer> {
  const database = await getDatabase();
  const result = await database.query<{
    user_id: string; user_public_id: string; display_name: string; email: string;
    workspace_id: string; workspace_public_id: string; workspace_name: string; role: Viewer["role"];
  }>(
    `select user_account.id::text as user_id, user_account.public_id as user_public_id,
            user_account.display_name, user_account.email, workspace.id::text as workspace_id,
            workspace.public_id as workspace_public_id, workspace.name as workspace_name, member.role
     from workspaces workspace
     join workspace_members member on member.workspace_id = workspace.id and member.role in ('owner', 'admin')
     join users user_account on user_account.id = member.user_id
     where workspace.public_id = $1
     order by case member.role when 'owner' then 0 else 1 end, member.created_at
     limit 1`,
    [workspacePublicId],
  );
  const row = result.rows[0];
  if (!row) throw new Error("ZENODO_IMPORT_WORKSPACE_NOT_FOUND_OR_NOT_ADMIN");
  return {
    userId: row.user_id,
    userPublicId: row.user_public_id,
    displayName: row.display_name,
    email: row.email,
    workspaceId: row.workspace_id,
    workspacePublicId: row.workspace_public_id,
    workspaceName: row.workspace_name,
    role: row.role,
    tokenBalance: 0,
  };
}

async function alreadyImported(workspaceId: string, sourceUri: string) {
  const database = await getDatabase();
  const result = await database.query<{ public_id: string }>(
    `select public_id from context_assets where workspace_id = $1 and source_uri = $2 limit 1`,
    [workspaceId, sourceUri],
  );
  return result.rows[0]?.public_id ?? null;
}

async function main() {
  if (process.env.ZENODO_LLM_INTERVIEWS_IMPORT_CONFIRM !== "1") {
    throw new Error("Set ZENODO_LLM_INTERVIEWS_IMPORT_CONFIRM=1 to import the approved Zenodo interview dataset.");
  }
  const workspacePublicId = process.env.ZENODO_IMPORT_WORKSPACE_PUBLIC_ID?.trim();
  if (!workspacePublicId) throw new Error("Set ZENODO_IMPORT_WORKSPACE_PUBLIC_ID to an owner/admin workspace public ID.");
  const [viewer, record] = await Promise.all([loadViewer(workspacePublicId), fetchJson(RECORD_URL)]);
  const description = record.metadata.description.toLowerCase();
  if (record.metadata.access_right !== "open" || record.metadata.license?.id !== "cc-by-4.0") {
    throw new Error("ZENODO_LICENSE_OR_ACCESS_INVALID");
  }
  if (!description.includes("anonymized") || !description.includes("explicit consent")) {
    throw new Error("ZENODO_CONSENT_OR_ANONYMIZATION_UNVERIFIED");
  }
  const files = record.files.filter((file) => FILE_PATTERN.test(file.key)).sort((left, right) => fileNumber(left) - fileNumber(right));
  if (files.length !== 20 || new Set(files.map(fileNumber)).size !== 20) throw new Error("ZENODO_EXPECTED_TRANSCRIPTS_MISSING");

  const checked = await Promise.all(files.map(async (file) => ({
    file,
    existingPublicId: await alreadyImported(viewer.workspaceId, file.links.self),
    content: await fetchTranscript(file),
  })));
  let imported = 0;
  let skipped = 0;
  for (const { file, existingPublicId, content } of checked) {
    if (existingPublicId) {
      skipped += 1;
      continue;
    }
    const participant = fileNumber(file);
    const created = await createContextAsset(viewer, {
      assetType: "research_sample",
      scope: "workspace",
      studyPublicId: null,
      title: `公开 LLM 访谈样本 P${participant}`,
      description: `Zenodo ${DOI} · ${record.metadata.title} · CC BY 4.0 · 原记录声明匿名化与参与者明确同意公开。`,
      sourceUri: file.links.self,
      content,
      changeNote: `Imported from Zenodo ${DOI}; verified MD5 and basic PII scan.`,
      ingestionMethod: "file",
      sourceName: file.key,
      sourceMimeType: "text/plain",
      evidenceKind: "human",
      consentStatus: "confirmed",
      piiStatus: "redacted",
      retentionExpiresAt: null,
      reviewStatus: "approved",
    });
    if (typeof created !== "object") throw new Error(`ZENODO_CONTEXT_IMPORT_FAILED:${file.key}:${created}`);
    imported += 1;
  }
  console.log(JSON.stringify({ recordId: RECORD_ID, doi: DOI, imported, skipped, workspacePublicId }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(closeDatabase);
