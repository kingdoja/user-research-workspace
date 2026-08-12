import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from "pg";

type Queryable = {
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
      connectionString,
      max: Number(process.env.DATABASE_POOL_SIZE ?? 5),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      ssl: { rejectUnauthorized: false },
    });
  }

  databaseGlobals.atypicaDatabase ??= createDatabase(databaseGlobals.atypicaPool);
  return databaseGlobals.atypicaDatabase;
}
