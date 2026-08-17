import "server-only";

import { createHash, randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import type { Viewer } from "@/lib/auth";
import { getDatabase } from "@/lib/db";
import { createPublicId } from "@/lib/identifiers";

export const API_KEY_SCOPES = [
  "context:read",
  "personas:read",
  "studies:read",
  "studies:write",
  "runs:read",
  "runs:write",
] as const;

export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

export const apiKeyInputSchema = z.object({
  name: z.string().trim().min(2, "名称至少需要 2 个字符").max(80),
  scopes: z.array(z.enum(API_KEY_SCOPES)).min(1, "至少选择一个权限").max(API_KEY_SCOPES.length)
    .refine((scopes) => new Set(scopes).size === scopes.length, "权限不能重复"),
  expiresInDays: z.number().int().min(1).max(365).nullable().default(90),
});

export type WorkspaceApiKey = {
  publicId: string;
  name: string;
  secretPrefix: string;
  scopes: ApiKeyScope[];
  expiresAt: string | null;
  expired: boolean;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  createdBy: string;
};

export type ApiAccessPrincipal = {
  viewer: Viewer;
  apiKeyPublicId: string;
  scopes: ApiKeyScope[];
  auditPublicId: string;
  requestId: string;
};

type ApiAccessFailure = {
  ok: false;
  response: NextResponse;
};

type ApiAccessSuccess = {
  ok: true;
  principal: ApiAccessPrincipal;
};

function hashSecret(secret: string) {
  return createHash("sha256").update(secret).digest("hex");
}

function canManageApiKeys(viewer: Viewer) {
  return viewer.role === "owner" || viewer.role === "admin";
}

export async function listWorkspaceApiKeys(viewer: Viewer): Promise<WorkspaceApiKey[]> {
  if (!canManageApiKeys(viewer)) return [];
  const database = await getDatabase();
  const result = await database.query<{
    public_id: string;
    name: string;
    secret_prefix: string;
    scopes: ApiKeyScope[];
    expires_at: string | null;
    expired: boolean;
    last_used_at: string | null;
    revoked_at: string | null;
    created_at: string;
    created_by: string;
  }>(
    `select key.public_id, key.name, key.secret_prefix, key.scopes,
            key.expires_at::text as expires_at, key.last_used_at::text as last_used_at,
            key.revoked_at::text as revoked_at, (key.expires_at is not null and key.expires_at <= now()) as expired,
            key.created_at::text as created_at,
            creator.display_name as created_by
     from workspace_api_keys key
     join users creator on creator.id = key.created_by
     where key.workspace_id = $1
     order by key.created_at desc, key.id desc`,
    [viewer.workspaceId],
  );
  return result.rows.map((row) => ({
    publicId: row.public_id,
    name: row.name,
    secretPrefix: row.secret_prefix,
    scopes: row.scopes,
    expiresAt: row.expires_at,
    expired: row.expired,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
    createdAt: row.created_at,
    createdBy: row.created_by,
  }));
}

export async function createWorkspaceApiKey(
  viewer: Viewer,
  input: z.infer<typeof apiKeyInputSchema>,
) {
  if (!canManageApiKeys(viewer)) return "forbidden" as const;
  const database = await getDatabase();
  const publicId = createPublicId("key");
  const secret = `atypica_sk_${randomBytes(32).toString("base64url")}`;
  const secretPrefix = `${secret.slice(0, 16)}...`;
  const expiresAt = input.expiresInDays === null
    ? null
    : new Date(Date.now() + input.expiresInDays * 86_400_000).toISOString();
  const created = await database.query<{ created_at: string }>(
    `insert into workspace_api_keys (
       public_id, workspace_id, created_by, name, secret_prefix, secret_hash, scopes, expires_at
     ) values ($1, $2, $3, $4, $5, $6, $7::text[], $8)
     returning created_at::text as created_at`,
    [publicId, viewer.workspaceId, viewer.userId, input.name, secretPrefix, hashSecret(secret), input.scopes, expiresAt],
  );
  return {
    publicId,
    secret,
    secretPrefix,
    name: input.name,
    scopes: input.scopes,
    expiresAt,
    expired: false,
    lastUsedAt: null,
    revokedAt: null,
    createdAt: created.rows[0].created_at,
    createdBy: viewer.displayName,
  };
}

export async function revokeWorkspaceApiKey(viewer: Viewer, publicId: string) {
  if (!canManageApiKeys(viewer)) return "forbidden" as const;
  const database = await getDatabase();
  const result = await database.query<{ revoked_at: string }>(
    `update workspace_api_keys
     set revoked_at = coalesce(revoked_at, now()), revoked_by = coalesce(revoked_by, $3)
     where public_id = $1 and workspace_id = $2
     returning revoked_at::text as revoked_at`,
    [publicId, viewer.workspaceId, viewer.userId],
  );
  return result.rows[0]?.revoked_at ?? "not_found" as const;
}

function bearerToken(request: Request) {
  const authorization = request.headers.get("authorization")?.trim() ?? "";
  const match = /^Bearer\s+([^\s]+)$/i.exec(authorization);
  return match?.[1] ?? null;
}

function accessError(error: string, status: number, requestId: string) {
  return NextResponse.json(
    { error: { code: error, message: error === "insufficient_scope" ? "API key does not grant the required scope." : "API key is invalid or inactive." } },
    { status, headers: { "x-request-id": requestId, "cache-control": "no-store" } },
  );
}

async function authorizeExternalApiRequest(
  request: Request,
  requiredScopeInput: ApiKeyScope | readonly ApiKeyScope[],
): Promise<ApiAccessFailure | ApiAccessSuccess> {
  const requiredScopes = Array.isArray(requiredScopeInput) ? requiredScopeInput : [requiredScopeInput];
  const requestId = request.headers.get("x-request-id")?.trim().slice(0, 120) || createPublicId("req");
  const token = bearerToken(request);
  if (!token || !token.startsWith("atypica_sk_") || token.length > 200) {
    return { ok: false, response: accessError("invalid_api_key", 401, requestId) };
  }
  const database = await getDatabase();
  const result = await database.query<{
    id: string;
    public_id: string;
    workspace_id: string;
    workspace_public_id: string;
    workspace_name: string;
    token_balance: string;
    created_by: string;
    user_public_id: string;
    display_name: string;
    email: string;
    role: Viewer["role"] | null;
    scopes: ApiKeyScope[];
    expires_at: string | null;
    expired: boolean;
    revoked_at: string | null;
  }>(
    `select key.id::text as id, key.public_id, key.workspace_id::text as workspace_id,
            workspace.public_id as workspace_public_id, workspace.name as workspace_name,
            workspace.token_balance::text as token_balance, key.created_by::text as created_by,
            creator.public_id as user_public_id, creator.display_name, creator.email,
            member.role, key.scopes, key.expires_at::text as expires_at,
            (key.expires_at is not null and key.expires_at <= now()) as expired,
            key.revoked_at::text as revoked_at
     from workspace_api_keys key
     join workspaces workspace on workspace.id = key.workspace_id
     join users creator on creator.id = key.created_by
     left join workspace_members member
       on member.workspace_id = key.workspace_id and member.user_id = key.created_by
     where key.secret_hash = $1
     limit 1`,
    [hashSecret(token)],
  );
  const key = result.rows[0];
  if (!key) return { ok: false, response: accessError("invalid_api_key", 401, requestId) };

  const grantedScope = requiredScopes.find((scope) => key.scopes.includes(scope));
  const outcome = key.revoked_at
    ? "revoked"
    : key.expires_at && new Date(key.expires_at).getTime() <= Date.now()
      ? "expired"
      : !key.role
        ? "membership_revoked"
        : !grantedScope
          ? "scope_denied"
          : "authorized";
  const auditPublicId = createPublicId("aud");
  const deniedStatus = outcome === "scope_denied" ? 403 : outcome === "authorized" ? null : 401;
  await database.query(
    `insert into external_api_audit_events (
       public_id, workspace_id, api_key_id, actor_user_id, request_id,
       method, request_path, required_scope, outcome, response_status, finished_at
     ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
               case when $10::integer is null then null else now() end)`,
    [
      auditPublicId, key.workspace_id, key.id, key.created_by, requestId,
      request.method, new URL(request.url).pathname, grantedScope ?? requiredScopes[0], outcome, deniedStatus,
    ],
  );
  if (outcome !== "authorized" || !key.role) {
    return {
      ok: false,
      response: accessError(outcome === "scope_denied" ? "insufficient_scope" : "invalid_api_key", deniedStatus ?? 401, requestId),
    };
  }
  await database.query("update workspace_api_keys set last_used_at = now() where id = $1", [key.id]);
  return {
    ok: true,
    principal: {
      apiKeyPublicId: key.public_id,
      scopes: key.scopes,
      auditPublicId,
      requestId,
      viewer: {
        userId: key.created_by,
        userPublicId: key.user_public_id,
        displayName: key.display_name,
        email: key.email,
        workspaceId: key.workspace_id,
        workspacePublicId: key.workspace_public_id,
        workspaceName: key.workspace_name,
        role: key.role,
        tokenBalance: Number(key.token_balance),
      },
    },
  };
}

async function finishExternalApiAudit(auditPublicId: string, responseStatus: number) {
  const database = await getDatabase();
  await database.query(
    `update external_api_audit_events
     set response_status = $2, finished_at = now()
     where public_id = $1 and response_status is null`,
    [auditPublicId, responseStatus],
  );
}

export async function withExternalApiAuth(
  request: Request,
  requiredScope: ApiKeyScope,
  handler: (principal: ApiAccessPrincipal) => Promise<NextResponse>,
) {
  const authorization = await authorizeExternalApiRequest(request, requiredScope);
  if (!authorization.ok) return authorization.response;
  try {
    const response = await handler(authorization.principal);
    response.headers.set("x-request-id", authorization.principal.requestId);
    response.headers.set("cache-control", "no-store");
    await finishExternalApiAudit(authorization.principal.auditPublicId, response.status);
    return response;
  } catch (error) {
    await finishExternalApiAudit(authorization.principal.auditPublicId, 500);
    throw error;
  }
}

export async function withExternalApiAuthAny(
  request: Request,
  requiredScopes: readonly ApiKeyScope[],
  handler: (principal: ApiAccessPrincipal) => Promise<NextResponse>,
) {
  const authorization = await authorizeExternalApiRequest(request, requiredScopes);
  if (!authorization.ok) return authorization.response;
  try {
    const response = await handler(authorization.principal);
    response.headers.set("x-request-id", authorization.principal.requestId);
    response.headers.set("cache-control", "no-store");
    await finishExternalApiAudit(authorization.principal.auditPublicId, response.status);
    return response;
  } catch (error) {
    await finishExternalApiAudit(authorization.principal.auditPublicId, 500);
    throw error;
  }
}
