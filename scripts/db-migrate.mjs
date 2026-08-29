#!/usr/bin/env node
/**
 * Applies every file in supabase/migrations/, in filename order, that
 * hasn't been applied yet. Tracks applied migrations in a
 * `schema_migrations` table so this is safe to re-run.
 *
 * Requires SUPABASE_DB_URL (Project Settings → Database → Connection
 * string, "Direct connection" — not the pooled one, since this runs DDL).
 *
 * Usage: npm run db:migrate
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import "dotenv/config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.join(__dirname, "..", "supabase", "migrations");

const connectionString = process.env.SUPABASE_DB_URL;
if (!connectionString) {
  console.error(
    "Missing SUPABASE_DB_URL. Copy .env.example to .env.local and set it to your Supabase project's direct database connection string."
  );
  process.exit(1);
}

const client = new pg.Client({ connectionString, ssl: { rejectUnauthorized: false } });

async function main() {
  await client.connect();

  await client.query(`
    create table if not exists schema_migrations (
      filename text primary key,
      applied_at timestamptz not null default now()
    );
  `);

  const files = (await readdir(migrationsDir))
    .filter((f) => f.endsWith(".sql"))
    .sort();

  const { rows } = await client.query("select filename from schema_migrations");
  const applied = new Set(rows.map((r) => r.filename));

  let appliedCount = 0;
  for (const file of files) {
    if (applied.has(file)) continue;

    const sql = await readFile(path.join(migrationsDir, file), "utf8");
    console.log(`Applying ${file}...`);

    try {
      await client.query("begin");
      await client.query(sql);
      await client.query("insert into schema_migrations (filename) values ($1)", [file]);
      await client.query("commit");
      appliedCount++;
    } catch (err) {
      await client.query("rollback");
      console.error(`Migration ${file} failed:`, err.message);
      process.exit(1);
    }
  }

  if (appliedCount === 0) {
    console.log("Database already up to date.");
  } else {
    console.log(`Applied ${appliedCount} migration(s).`);
  }

  await client.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
