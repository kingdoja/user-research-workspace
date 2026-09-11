import { getDatabase } from "@/lib/db";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export type Viewer = {
  userId: string;
  userPublicId: string;
  displayName: string;
  email: string;
  workspaceId: string;
  workspacePublicId: string;
  workspaceName: string;
  role: "owner" | "admin" | "member" | "viewer";
  isPlatformAdmin?: boolean;
  tokenBalance: number;
};

export type AccountCreationErrorCode =
  | "EMAIL_EXISTS"
  | "EMAIL_INVALID"
  | "EMAIL_RATE_LIMITED"
  | "PASSWORD_WEAK";

function getAccountCreationErrorCode(code?: string): AccountCreationErrorCode | null {
  switch (code) {
    case "email_exists":
    case "user_already_exists":
      return "EMAIL_EXISTS";
    case "email_address_invalid":
      return "EMAIL_INVALID";
    case "over_email_send_rate_limit":
    case "over_request_rate_limit":
      return "EMAIL_RATE_LIMITED";
    case "weak_password":
      return "PASSWORD_WEAK";
    default:
      return null;
  }
}

export async function createAccount(input: { name: string; email: string; password: string }) {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.signUp({
    email: input.email.trim().toLowerCase(),
    password: input.password,
    options: { data: { display_name: input.name.trim() } },
  });

  if (error) {
    const knownCode = getAccountCreationErrorCode(error.code);
    if (knownCode) {
      throw new Error(knownCode);
    }
    if (/already registered|already exists/i.test(error.message)) {
      throw new Error("EMAIL_EXISTS");
    }
    throw error;
  }

  return { requiresEmailConfirmation: !data.session };
}

export async function authenticateAccount(emailInput: string, password: string) {
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.signInWithPassword({
    email: emailInput.trim().toLowerCase(),
    password,
  });

  return !error;
}

export async function deleteCurrentSession() {
  const supabase = await createSupabaseServerClient();
  await supabase.auth.signOut();
}

export async function getViewer(): Promise<Viewer | null> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.getClaims();
  const authUserId = data?.claims.sub;

  if (error || !authUserId) {
    return null;
  }

  const database = await getDatabase();
  const result = await database.query<{
    user_id: string;
    user_public_id: string;
    display_name: string;
    email: string;
    workspace_id: string;
    workspace_public_id: string;
    workspace_name: string;
    role: Viewer["role"];
    is_platform_admin: boolean;
    token_balance: string;
  }>(
    `select
       users.id::text as user_id,
       users.public_id as user_public_id,
       users.display_name,
       users.email,
       workspaces.id::text as workspace_id,
       workspaces.public_id as workspace_public_id,
       workspaces.name as workspace_name,
       workspace_members.role,
       users.is_platform_admin,
       workspaces.token_balance::text as token_balance
     from users
     join workspace_members on workspace_members.user_id = users.id
     join workspaces on workspaces.id = workspace_members.workspace_id
     where users.auth_user_id = $1
     order by workspace_members.created_at asc
     limit 1`,
    [authUserId],
  );
  const row = result.rows[0];

  if (!row) {
    return null;
  }

  return {
    userId: row.user_id,
    userPublicId: row.user_public_id,
    displayName: row.display_name,
    email: row.email,
    workspaceId: row.workspace_id,
    workspacePublicId: row.workspace_public_id,
    workspaceName: row.workspace_name,
    role: row.role,
    isPlatformAdmin: row.is_platform_admin,
    tokenBalance: Number(row.token_balance),
  };
}
