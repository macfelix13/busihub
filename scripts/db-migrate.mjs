#!/usr/bin/env node
/**
 * Applies every file in supabase/migrations/, in filename order, that
 * hasn't been applied yet. Tracks applied migrations in a
 * `schema_migrations` table so this is safe to re-run.
 *
 * Requires SUPABASE_DB_URL (Project Settings → Database → Connection
 * string). "Direct connection" works if your network has IPv6 reachability
 * (Supabase's direct-connection hostname is IPv6-only unless the project
 * has the paid IPv4 add-on); otherwise use the "Session pooler" string
 * (port 5432, username postgres.<project-ref>) — session-mode pooling is a
 * full persistent connection and supports DDL/transactions/extensions
 * fine. Avoid the "Transaction pooler" (port 6543) for this script.
 *
 * Usage: npm run db:migrate
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { config as loadEnv } from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, "..");

// Bare `dotenv/config` only loads `.env`. Next.js auto-loads `.env.local`
// for the app itself, but these are plain Node scripts, so we replicate
// that convention explicitly: prefer `.env.local`, fall back to `.env`.
loadEnv({ path: path.join(repoRoot, ".env.local") });
loadEnv({ path: path.join(repoRoot, ".env") });

const migrationsDir = path.join(repoRoot, "supabase", "migrations");

// A leading UTF-8 BOM (U+FEFF) is invisible in most editors/terminals but
// is NOT whitespace to Postgres's parser — pg sends the file's raw text
// as the query, so a BOM-prefixed file fails with a confusing "syntax
// error at or near """ (the blank quotes ARE the BOM). Windows
// PowerShell's `-Encoding UTF8` always adds one (confirmed the exact
// failure this way against a real migration file), and other Windows
// editors can too — stripped defensively so this can't recur regardless
// of what tool wrote the file.
function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

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

    const sql = stripBom(await readFile(path.join(migrationsDir, file), "utf8"));
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