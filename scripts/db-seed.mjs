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
import "dotenv/config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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
  const sql = await readFile(path.join(__dirname, "..", "supabase", "seed.sql"), "utf8");
  await client.query(sql);
  console.log("Seed complete.");
  await client.end();
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
