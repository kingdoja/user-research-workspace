import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from "pg";
import type { ConnectionOptions } from "node:tls";

export type Queryable = {
  query<Row extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<QueryResult<Row>>;
};

export type Database = Queryable & {
  transaction<Result>(callback: (transaction: Queryable) => Promise<Result>): Promise<Result>;
};

type DatabaseGlobals = typeof globalThis & {
  atypicaPool?: Pool;
  atypicaDatabase?: Database;
};

const databaseGlobals = globalThis as DatabaseGlobals;

type DatabaseSslMode = "disable" | "require" | "verify-full";

function databaseSslConfig(): false | ConnectionOptions {
  const fallbackMode: DatabaseSslMode = process.env.NODE_ENV === "production" ? "verify-full" : "require";
  const mode = (process.env.DATABASE_SSL_MODE?.trim().toLowerCase() || fallbackMode) as DatabaseSslMode;
  if (mode === "disable") return false;
  if (mode === "require") return { rejectUnauthorized: false };
  if (mode !== "verify-full") {
    throw new Error("DATABASE_SSL_MODE must be one of: disable, require, verify-full");
  }

  const ca = process.env.DATABASE_SSL_CA?.replaceAll("\\n", "\n").trim();
  return {
    rejectUnauthorized: true,
    ...(ca ? { ca } : {}),
  };
}

function databasePoolSize() {
  const value = Number(process.env.DATABASE_POOL_SIZE ?? 5);
  if (!Number.isInteger(value) || value < 1 || value > 100) {
    throw new Error("DATABASE_POOL_SIZE must be an integer between 1 and 100");
  }
  return value;
}

function normalizedDatabaseUrl(value: string) {
  const url = new URL(value);
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error("DATABASE_URL must use the postgres or postgresql protocol");
  }
  // node-postgres lets connection-string SSL parameters replace the explicit
  // TLS object. Keep one authoritative SSL policy in DATABASE_SSL_MODE.
  for (const key of ["sslmode", "sslcert", "sslkey", "sslrootcert"]) {
    url.searchParams.delete(key);
  }
  return url.toString();
}

function createDatabase(pool: Pool): Database {
  return {
    query: (text, values) => pool.query(text, values),
    async transaction<Result>(callback: (transaction: Queryable) => Promise<Result>) {
      const client: PoolClient = await pool.connect();

      try {
        await client.query("begin");
        const result = await callback(client);
        await client.query("commit");
        return result;
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    },
  };
}

export async function getDatabase() {
  const connectionString = process.env.DATABASE_URL;

  if (!connectionString) {
    throw new Error("DATABASE_URL is not configured");
  }

  if (!databaseGlobals.atypicaPool) {
    databaseGlobals.atypicaPool = new Pool({
      connectionString: normalizedDatabaseUrl(connectionString),
      max: databasePoolSize(),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      ssl: databaseSslConfig(),
    });
  }

  databaseGlobals.atypicaDatabase ??= createDatabase(databaseGlobals.atypicaPool);
  return databaseGlobals.atypicaDatabase;
}

export async function closeDatabase() {
  const pool = databaseGlobals.atypicaPool;
  databaseGlobals.atypicaDatabase = undefined;
  databaseGlobals.atypicaPool = undefined;
  await pool?.end();
}
