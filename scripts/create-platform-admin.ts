import { loadEnvConfig } from "@next/env";
import { createClient } from "@supabase/supabase-js";
import { getDatabase } from "@/lib/db";

async function main() {
  loadEnvConfig(process.cwd());
  const email = process.env.PLATFORM_ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.PLATFORM_ADMIN_PASSWORD;
  const displayName = process.env.PLATFORM_ADMIN_NAME?.trim() || "平台管理员";
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;

  if (!email) {
    throw new Error("需要 PLATFORM_ADMIN_EMAIL；已有账号可直接提升，创建新账号时再配置 PLATFORM_ADMIN_PASSWORD、SUPABASE_SERVICE_ROLE_KEY 和 NEXT_PUBLIC_SUPABASE_URL");
  }

  let authUserId: string | undefined;
  if (serviceRoleKey && supabaseUrl) {
    const supabase = createClient(supabaseUrl, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });
    const { data: existing, error: lookupError } = await supabase.auth.admin.listUsers({ page: 1, perPage: 1000 });
    if (lookupError) throw lookupError;
    const authUser = existing.users.find((user) => user.email?.toLowerCase() === email);
    if (authUser) {
      authUserId = authUser.id;
    } else {
      if (!password) throw new Error("创建新的 Supabase 管理员账号还需要 PLATFORM_ADMIN_PASSWORD");
      const created = await supabase.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { display_name: displayName } });
      if (created.error || !created.data.user) throw created.error ?? new Error("无法创建管理员账号");
      authUserId = created.data.user.id;
    }
  }

  const database = await getDatabase();
  if (!authUserId) {
    const existing = await database.query<{ auth_user_id: string }>("select auth_user_id::text from users where email = $1 limit 1", [email]);
    authUserId = existing.rows[0]?.auth_user_id;
    if (!authUserId) throw new Error("找不到该邮箱对应的业务账号，请先在应用中注册，或配置 Supabase service role 以创建新账号");
  }
  const result = await database.query<{ public_id: string }>(
    `update users
        set is_platform_admin = true, display_name = $2, updated_at = now()
      where auth_user_id = $1
      returning public_id`,
    [authUserId, displayName],
  );
  if (!result.rows[0]) throw new Error("Supabase 账号已创建，但业务 users 记录尚未生成，请检查数据库触发器");
  console.log(`平台管理员已就绪: ${email} (${result.rows[0].public_id})`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
