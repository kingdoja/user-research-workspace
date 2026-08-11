import { PGlite } from "@electric-sql/pglite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { SCHEMA_SQL } from "@/lib/db-schema";

type DatabaseGlobals = typeof globalThis & {
  atypicaDb?: PGlite;
  atypicaDbReady?: Promise<PGlite>;
};

const databaseGlobals = globalThis as DatabaseGlobals;
const dataDirectory = process.env.PGLITE_DATA_DIR ?? path.resolve(process.cwd(), ".data/atypica");

mkdirSync(dataDirectory, { recursive: true });

export async function getDatabase() {
  if (!databaseGlobals.atypicaDbReady) {
    const database = databaseGlobals.atypicaDb ?? new PGlite(dataDirectory);
    databaseGlobals.atypicaDb = database;
    databaseGlobals.atypicaDbReady = database.exec(SCHEMA_SQL).then(() => database);
  }

  return databaseGlobals.atypicaDbReady;
}
