/**
 * Checks a DEPLOYED Supabase project from outside, using only the publishable
 * key — the same credentials any visitor's browser has.
 *
 * Run: node --env-file=.env.local scripts/verify-live.mjs
 *
 * WHY THIS EXISTS, in one sentence: 139 local tests and a verified migration
 * bundle still missed two real flaws in the live project, because local tests
 * prove your logic while only the deployed system proves your assumptions about
 * the platform. Supabase grants new public tables to `anon` by default; PGlite
 * does not. That divergence is invisible to any test suite.
 *
 * It writes nothing. Every call either reads, or is refused before it can act.
 */
const rawUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key =
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!rawUrl || !key) {
  console.error("Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY.");
  console.error("Run with: node --env-file=.env.local scripts/verify-live.mjs");
  process.exit(2);
}
if (/^sb_secret_|service_role/.test(key)) {
  console.error("That is a SECRET key. Never use it from a client, not even here.");
  process.exit(2);
}

const url = rawUrl.replace(/\/$/, "");
const h = { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
const Z = "00000000-0000-4000-8000-000000000000";
let failures = 0;

function check(ok, label, detail) {
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(46)} ${detail}`);
}

async function post(path, body) {
  const r = await fetch(url + path, { method: "POST", headers: h, body: JSON.stringify(body) });
  let b = {};
  try { b = await r.json(); } catch {}
  return { status: r.status, body: b };
}

/* ---------------------------------------------------------------- secrets */

console.log("\n[1] credentials");
check(/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(url), "project URL looks like a Supabase project", "ok");
check(!/^sb_secret_|service_role/.test(key), "key is publishable, not secret", "ok");

/* ------------------------------------------------- tenant tables are shut */

console.log("\n[2] anon holds no table privileges (migration 0005)");
for (const t of [
  "organizations", "profiles", "organization_members",
  "categories", "suppliers", "products", "batches", "stock_movements",
]) {
  const r = await fetch(`${url}/rest/v1/${t}?select=*&limit=1`, { headers: h });
  let b = {};
  try { b = await r.json(); } catch {}
  const denied = r.status === 401 && /permission denied/i.test(b.message ?? "");
  const missing = b.code === "PGRST205";
  check(
    denied,
    `anon cannot read ${t}`,
    denied ? "permission denied" : missing ? "TABLE MISSING — migrations not applied" : `http=${r.status} ${JSON.stringify(b).slice(0, 60)}`,
  );
}

/* ---------------------------------------------- functions exist and are shut */

console.log("\n[3] stock functions: signature matches the client, anon cannot execute");
// EXACTLY the argument names SupabaseInventoryRepository sends. PostgREST
// resolves a function by argument names BEFORE checking privileges, so
// "permission denied for function" proves the signature matched, while
// PGRST202 means the client and the database disagree about the parameters.
const calls = {
  receive_stock: {
    p_product_id: Z, p_batch_number: "X", p_quantity: 1, p_received_at: "2026-01-01",
    p_expiry_date: null, p_unit_cost: null, p_supplier_id: null, p_notes: null,
  },
  issue_stock: { p_batch_id: Z, p_quantity: 1, p_reason: "verify", p_notes: null },
  adjust_stock: { p_batch_id: Z, p_quantity_delta: -1, p_reason: "verify", p_notes: null },
  reverse_movement: { p_movement_id: Z, p_reason: "verify" },
  create_organization: { p_name: "verify", p_timezone: "UTC" },
  seed_default_categories: { p_organization_id: Z },
};
for (const [fn, body] of Object.entries(calls)) {
  const { status, body: b } = await post(`/rest/v1/rpc/${fn}`, body);
  const matched = /permission denied for function/i.test(b.message ?? "");
  check(
    matched,
    `${fn} — signature matches, anon denied`,
    matched ? "permission denied for function" : b.code === "PGRST202" ? "ARGUMENT NAMES MISMATCH" : `http=${status} detail=${b.details ?? b.code ?? "-"}`,
  );
}

// Proves the test above is capable of failing. A check that cannot fail is not
// a check.
const control = await post("/rest/v1/rpc/issue_stock", { batch_id: Z, quantity: 1, reason: "verify" });
check(control.body.code === "PGRST202", "control: deliberately wrong names are rejected",
  control.body.code === "PGRST202" ? "rejected as expected" : "CONTROL DID NOT FAIL — the checks above prove nothing");

/* ------------------------------------------------------------------- auth */

console.log("\n[4] auth configuration");
const settings = await fetch(`${url}/auth/v1/settings`, { headers: h }).then((r) => r.json());
check(settings.disable_signup === false, "sign-up is enabled", `disable_signup=${settings.disable_signup}`);
console.log(
  `  INFO  ${"email confirmation required".padEnd(46)} ` +
  (settings.mailer_autoconfirm === true
    ? "no — autoconfirm is on (convenient for development)"
    : "YES — a new account must click an emailed link before it can sign in"),
);

/* ----------------------------------------------------------------- verdict */

console.log(
  "\n" +
  (failures === 0
    ? "ALL CHECKS PASSED. Note what this does NOT prove: no signed-in request was\n" +
      "made, so the reads, the role lookup and the stock functions have not been\n" +
      "exercised against live data. Sign in through the app for that."
    : `${failures} CHECK(S) FAILED — see above.`),
);
process.exit(failures === 0 ? 0 : 1);
