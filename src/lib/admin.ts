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

export function isPlatformAdmin(viewer: Viewer) {
  return viewer.isPlatformAdmin;
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

export async function listAdminStudies(viewer: Viewer, limit = 250): Promise<AdminStudySummary[]> {
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
      order by study.updated_at desc
      limit $1`,
    [limit],
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
