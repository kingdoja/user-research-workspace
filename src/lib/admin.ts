import type { Viewer } from "@/lib/auth";
import { getDatabase } from "@/lib/db";

export type AdminUserSummary = {
  publicId: string;
  displayName: string;
  email: string;
  createdAt: string;
  workspaceCount: number;
  studyCount: number;
  reportCount: number;
};

export type AdminStudySummary = {
  publicId: string;
  title: string;
  brief: string;
  status: string;
  studyType: string;
  workspaceName: string;
  creatorName: string;
  creatorEmail: string;
  updatedAt: string;
  report: {
    publicId: string;
    title: string;
    description: string;
    content: Record<string, unknown>;
    generatedAt: string;
  } | null;
  artifactCount: number;
};

export type AdminReportDetail = {
  publicId: string;
  title: string;
  description: string;
  content: Record<string, unknown>;
  generatedAt: string;
  study: { publicId: string; title: string; brief: string; status: string };
  owner: { displayName: string; email: string };
  workspaceName: string;
  artifacts: Array<{ publicId: string; type: string; title: string; content: unknown; createdAt: string }>;
};

export function isPlatformAdmin(viewer: Viewer) {
  return viewer.isPlatformAdmin === true;
}

export function requirePlatformAdmin(viewer: Viewer) {
  if (!isPlatformAdmin(viewer)) {
    throw new Error("FORBIDDEN");
  }
}

function jsonObject(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : {};
    } catch {
      return {};
    }
  }
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export async function listAdminUsers(viewer: Viewer): Promise<AdminUserSummary[]> {
  requirePlatformAdmin(viewer);
  const database = await getDatabase();
  const result = await database.query<AdminUserSummary & { workspace_count: string; study_count: string; report_count: string; public_id: string; display_name: string; created_at: string }>(
    `select u.public_id, u.display_name, u.email, u.created_at::text as created_at,
            count(distinct wm.workspace_id)::text as workspace_count,
            count(distinct s.id)::text as study_count,
            count(distinct r.id)::text as report_count
       from users u
       left join workspace_members wm on wm.user_id = u.id
       left join studies s on s.created_by = u.id
       left join reports r on r.study_id = s.id
      group by u.id
      order by u.created_at desc`,
  );
  return result.rows.map((row) => ({
    publicId: row.public_id,
    displayName: row.display_name,
    email: row.email,
    createdAt: row.created_at,
    workspaceCount: Number(row.workspace_count),
    studyCount: Number(row.study_count),
    reportCount: Number(row.report_count),
  }));
}

export async function listAdminStudies(viewer: Viewer): Promise<AdminStudySummary[]> {
  requirePlatformAdmin(viewer);
  const database = await getDatabase();
  const result = await database.query<{
    public_id: string; title: string; brief: string; status: string; study_type: string;
    workspace_name: string; creator_name: string; creator_email: string; updated_at: string;
    report_public_id: string | null; report_title: string | null; report_description: string | null;
    report_content: unknown; report_generated_at: string | null; artifact_count: string;
  }>(
    `select study.public_id, study.title, study.brief, study.status, study.study_type,
            workspace.name as workspace_name, app_user.display_name as creator_name,
            app_user.email as creator_email, study.updated_at::text as updated_at,
            report.public_id as report_public_id, report.title as report_title,
            report.description as report_description, report.content_json as report_content,
            report.generated_at::text as report_generated_at,
            count(distinct artifact.id)::text as artifact_count
       from studies study
       join workspaces workspace on workspace.id = study.workspace_id
       join users app_user on app_user.id = study.created_by
       left join reports report on report.study_id = study.id
       left join study_artifacts artifact on artifact.study_id = study.id
      group by study.id, workspace.id, app_user.id, report.id
      order by study.updated_at desc`,
  );
  return result.rows.map((row) => ({
    publicId: row.public_id,
    title: row.title,
    brief: row.brief,
    status: row.status,
    studyType: row.study_type,
    workspaceName: row.workspace_name,
    creatorName: row.creator_name,
    creatorEmail: row.creator_email,
    updatedAt: row.updated_at,
    report: row.report_public_id && row.report_title && row.report_generated_at
      ? {
          publicId: row.report_public_id,
          title: row.report_title,
          description: row.report_description ?? "",
          content: jsonObject(row.report_content),
          generatedAt: row.report_generated_at,
        }
      : null,
    artifactCount: Number(row.artifact_count),
  }));
}

export async function getAdminReport(viewer: Viewer, publicId: string): Promise<AdminReportDetail | null> {
  requirePlatformAdmin(viewer);
  const database = await getDatabase();
  const result = await database.query<{
    report_public_id: string; report_title: string; report_description: string;
    report_content: unknown; report_generated_at: string; study_public_id: string;
    study_title: string; study_brief: string; study_status: string; workspace_name: string;
    owner_name: string; owner_email: string; study_id: string;
  }>(
    `select report.public_id as report_public_id, report.title as report_title,
            report.description as report_description, report.content_json as report_content,
            report.generated_at::text as report_generated_at, study.public_id as study_public_id,
            study.title as study_title, study.brief as study_brief, study.status as study_status,
            workspace.name as workspace_name, app_user.display_name as owner_name,
            app_user.email as owner_email, study.id::text as study_id
       from reports report
       join studies study on study.id = report.study_id
       join workspaces workspace on workspace.id = study.workspace_id
       join users app_user on app_user.id = study.created_by
      where report.public_id = $1
      limit 1`,
    [publicId],
  );
  const row = result.rows[0];
  if (!row) return null;
  const artifacts = await database.query<{ public_id: string; artifact_type: string; title: string; content: unknown; created_at: string }>(
    `select public_id, artifact_type, title, content, created_at::text as created_at
       from study_artifacts
      where study_id = $1
      order by created_at asc, id asc`,
    [row.study_id],
  );
  return {
    publicId: row.report_public_id,
    title: row.report_title,
    description: row.report_description,
    content: jsonObject(row.report_content),
    generatedAt: row.report_generated_at,
    study: { publicId: row.study_public_id, title: row.study_title, brief: row.study_brief, status: row.study_status },
    owner: { displayName: row.owner_name, email: row.owner_email },
    workspaceName: row.workspace_name,
    artifacts: artifacts.rows.map((artifact) => ({
      publicId: artifact.public_id,
      type: artifact.artifact_type,
      title: artifact.title,
      content: artifact.content,
      createdAt: artifact.created_at,
    })),
  };
}
