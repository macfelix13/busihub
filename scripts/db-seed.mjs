#!/usr/bin/env node
/**
 * Loads supabase/seed.sql — development/test data only. Refuses to run
 * unless the operator explicitly confirms, and warns loudly if the target
 * connection string doesn't look like a local/dev Supabase project.
 *
 * Usage: npm run db:seed
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import readline from "node:readline/promises";
import pg from "pg";
import { config as loadEnv } from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Bare `dotenv/config` only loads `.env`. Next.js auto-loads `.env.local`
// for the app itself, but this is a plain Node script, so we replicate
// that convention explicitly: prefer `.env.local`, fall back to `.env`.
loadEnv({ path: path.join(__dirname, "..", ".env.local") });
loadEnv({ path: path.join(__dirname, "..", ".env") });

// See scripts/db-migrate.mjs's stripBom() for why this is needed — a
// leading UTF-8 BOM fails as a confusing "syntax error at or near """
// against Postgres, since pg sends the file's raw text as the query.
function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

const connectionString = process.env.SUPABASE_DB_URL;
if (!connectionString) {
  console.error("Missing SUPABASE_DB_URL. See .env.example.");
  process.exit(1);
}

const looksLikeProd = !/localhost|127\.0\.0\.1|dev|staging|test/i.test(connectionString);

console.warn(
  "\n⚠ This loads supabase/seed.sql: fake demo business data plus a demo\n" +
    "  login (owner@busihub.dev.example / DevPassword123!). Never run this\n" +
    "  against a production project.\n"
);

if (looksLikeProd) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(
    "The configured SUPABASE_DB_URL doesn't obviously look like a dev/local project. Type YES to continue anyway: "
  );
  rl.close();
  if (answer !== "YES") {
    console.log("Aborted.");
    process.exit(1);
  }
}

const client = new pg.Client({ connectionString, ssl: { rejectUnauthorized: false } });

async function main() {
  await client.connect();
  const sql = stripBom(await readFile(path.join(__dirname, "..", "supabase", "seed.sql"), "utf8"));
  await client.query(sql);
  console.log("Seed complete.");
  await client.end();
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});