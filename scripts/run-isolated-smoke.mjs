import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { Client } from "pg";

const smokeName = process.argv[2] ?? "interview-metrics";
const allowedSmokes = new Map([
  ["interview-metrics", { command: "pnpm", args: ["smoke:interview-metrics"], confirmation: "INTERVIEW_METRICS_SMOKE_CONFIRM" }],
]);
const smoke = allowedSmokes.get(smokeName);
if (!smoke) throw new Error(`Unsupported isolated smoke: ${smokeName}`);

const sourceUrl = new URL(process.env.LOCAL_SMOKE_DATABASE_URL ?? "");
if (!["localhost", "127.0.0.1"].includes(sourceUrl.hostname)) {
  throw new Error("Set LOCAL_SMOKE_DATABASE_URL to a localhost PostgreSQL URL.");
}

const databaseName = `atypica_smoke_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
const adminUrl = new URL(sourceUrl);
adminUrl.pathname = "/postgres";
const smokeUrl = new URL(sourceUrl);
smokeUrl.pathname = `/${databaseName}`;

function runSmoke() {
  return new Promise((resolve, reject) => {
    const child = spawn(smoke.command, smoke.args, {
      cwd: process.cwd(),
      env: {
        ...process.env,
        DATABASE_URL: smokeUrl.toString(),
        DATABASE_SSL_MODE: "disable",
        [smoke.confirmation]: "1",
      },
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`${smokeName} exited with ${code}`)));
  });
}

async function main() {
  const admin = new Client({ connectionString: adminUrl.toString(), ssl: false });
  await admin.connect();
  try {
    await admin.query(`create database ${databaseName}`);
    const database = new Client({ connectionString: smokeUrl.toString(), ssl: false });
    await database.connect();
    try {
      await database.query(`
        create schema auth;
        create role authenticated nologin;
        create function auth.uid() returns uuid language sql stable as
          $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
        create table auth.users (
          id uuid primary key,
          email text not null,
          raw_user_meta_data jsonb not null default '{}'::jsonb
        );
      `);
      const migrations = (await readdir("supabase/migrations"))
        .filter((name) => name.endsWith(".sql"))
        .sort();
      for (const migration of migrations) {
        await database.query(await readFile(`supabase/migrations/${migration}`, "utf8"));
      }
    } finally {
      await database.end();
    }
    await runSmoke();
    console.log(JSON.stringify({ smoke: smokeName, migrationsApplied: true, isolated: true }));
  } finally {
    await admin.query(
      "select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()",
      [databaseName],
    );
    await admin.query(`drop database if exists ${databaseName}`);
    await admin.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
