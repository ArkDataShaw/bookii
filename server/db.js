import pg from "pg";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const { Pool } = pg;
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 5,
});

export async function q(text, params) {
  return pool.query(text, params);
}

export async function migrate() {
  const sql = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "schema.sql"), "utf8");
  await pool.query(sql);
  console.log("migrations applied");
}

if (process.argv[2] === "migrate") {
  migrate().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
}
