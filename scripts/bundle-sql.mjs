/**
 * Regenerates supabase/APPLY_ALL.sql from the numbered migrations.
 *
 * Why a bundle at all: without the Supabase CLI (which needs Docker) the only
 * way to apply DDL to a hosted project is the dashboard SQL Editor, and pasting
 * four files in the right order by hand is a step that can go wrong silently.
 * One file, wrapped in a single transaction, either fully applies or does
 * nothing.
 */
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const DIR = "supabase/migrations";
const files = readdirSync(DIR).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();

const header = readFileSync("supabase/APPLY_ALL.sql", "utf8").split("begin;")[0];
const body = files
  .map((f) => `\n\n-- ####################### ${f} #######################\n\n` + readFileSync(join(DIR, f), "utf8"))
  .join("");

writeFileSync("supabase/APPLY_ALL.sql", header + "begin;\n" + body + "\n\ncommit;\n");
console.log("bundled " + files.length + " migrations:", files.join(", "));
