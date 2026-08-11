import { createHash, randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { getDatabase } from "@/lib/db";
import { createPublicId } from "@/lib/identifiers";
import { hashPassword, verifyPassword } from "@/lib/passwords";

const SESSION_COOKIE = "atypica_session";
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

type UserCredentialsRow = {
  id: string;
  password_hash: string;
  password_salt: string;
};

export type Viewer = {
  userId: string;
  userPublicId: string;
  displayName: string;
  email: string;
  workspaceId: string;
  workspacePublicId: string;
  workspaceName: string;
  role: "owner" | "admin" | "member" | "viewer";
  tokenBalance: number;
};

function hashSessionToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export async function createLocalAccount(input: { name: string; email: string; password: string }) {
  const database = await getDatabase();
  const email = input.email.trim().toLowerCase();
  const name = input.name.trim();
  const password = await hashPassword(input.password);
  const userPublicId = createPublicId("usr");
  const workspacePublicId = createPublicId("wsp");

  return database.transaction(async (transaction) => {
    const existing = await transaction.query<{ id: string }>(
      "select id::text as id from users where email = $1 limit 1",
      [email],
    );

    if (existing.rows.length > 0) {
      throw new Error("EMAIL_EXISTS");
    }

    const userResult = await transaction.query<{ id: string }>(
      `insert into users (public_id, email, display_name, password_hash, password_salt)
       values ($1, $2, $3, $4, $5)
       returning id::text as id`,
      [userPublicId, email, name, password.hash, password.salt],
    );
    const userId = userResult.rows[0].id;

    const workspaceResult = await transaction.query<{ id: string }>(
      `insert into workspaces (public_id, name)
       values ($1, $2)
       returning id::text as id`,
      [workspacePublicId, `${name} 的研究工作区`],
    );
    const workspaceId = workspaceResult.rows[0].id;

    await transaction.query(
      "insert into workspace_members (workspace_id, user_id, role) values ($1, $2, 'owner')",
      [workspaceId, userId],
    );

    return { userId };
  });
}

export async function authenticateLocalAccount(emailInput: string, password: string) {
  const database = await getDatabase();
  const result = await database.query<UserCredentialsRow>(
    `select id::text as id, password_hash, password_salt
     from users
     where email = $1
     limit 1`,
    [emailInput.trim().toLowerCase()],
  );
  const user = result.rows[0];

  if (!user || !(await verifyPassword(password, user.password_salt, user.password_hash))) {
    return null;
  }

  return user.id;
}

export async function createSession(userId: string) {
  const database = await getDatabase();
  const token = randomBytes(32).toString("base64url");
  const tokenHash = hashSessionToken(token);
  const expiresAt = new Date(Date.now() + SESSION_MAX_AGE_SECONDS * 1000);

  await database.query(
    "insert into sessions (user_id, token_hash, expires_at) values ($1, $2, $3)",
    [userId, tokenHash, expiresAt.toISOString()],
  );

  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_MAX_AGE_SECONDS,
    priority: "high",
  });
}

export async function deleteCurrentSession() {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value;

  if (token) {
    const database = await getDatabase();
    await database.query("delete from sessions where token_hash = $1", [hashSessionToken(token)]);
  }

  cookieStore.delete(SESSION_COOKIE);
}

export async function getViewer(): Promise<Viewer | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;

  if (!token) {
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
       workspaces.token_balance::text as token_balance
     from sessions
     join users on users.id = sessions.user_id
     join workspace_members on workspace_members.user_id = users.id
     join workspaces on workspaces.id = workspace_members.workspace_id
     where sessions.token_hash = $1 and sessions.expires_at > now()
     order by workspace_members.created_at asc
     limit 1`,
    [hashSessionToken(token)],
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
    tokenBalance: Number(row.token_balance),
  };
}
