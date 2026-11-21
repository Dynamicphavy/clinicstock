/**
 * The concurrency test that was `it.todo` from milestone 5 to milestone 8.
 *
 * WHY THIS FILE NEEDS A REAL SERVER
 *
 * PGlite is one connection. Two transactions can only fight over a row lock if
 * there are two backend processes, so this suite starts a real PostgreSQL 18.6
 * (the `embedded-postgres` dev dependency: the official server binaries, run
 * as the current user, no Docker, no root) and opens several connections.
 *
 * It runs the byte-identical shim, migrations and seed as tests/db, imported
 * from the same harness.
 *
 * WHAT IT PROVES -- AND WHAT IT FOUND
 *
 * issue_stock decrements RELATIVELY (`quantity_on_hand - p_quantity`), and
 * the schema has CHECK (quantity_on_hand >= 0). Those two alone already stop
 * a negative balance, lock or no lock. So the honest question is not "does
 * FOR UPDATE stop the oversell" but "what does FOR UPDATE add":
 *
 *   * With the lock, the second caller waits BEFORE it validates, re-reads
 *     the committed balance, and is refused with INSUFFICIENT_STOCK -- a
 *     business error, raised before any write, with the true remaining count.
 *   * Without it (the control test below), the second caller validates
 *     against a stale balance, passes, and is stopped only by the CHECK at
 *     write time: a raw constraint violation (23514) instead of a refusal.
 *
 * Both leave correct data. Only one gives the nurse a correct answer.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { BATCH_A_GOOD, OFFICER_A, SEED, SUPABASE_SHIM, migrationSql } from "../db/harness";

const PASSWORD = "local-test-only";
const TEMPLATE = "clinicstock_template";

let server: EmbeddedPostgres;
let port: number;
let dataDir: string;
let database: string;
let counter = 0;
const open: pg.Client[] = [];

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const address = s.address();
      s.close(() => (typeof address === "object" && address ? resolve(address.port) : reject(new Error("no port"))));
    });
  });
}

async function connect(db: string): Promise<pg.Client> {
  const client = new pg.Client({ host: "127.0.0.1", port, user: "postgres", password: PASSWORD, database: db });
  await client.connect();
  open.push(client);
  return client;
}

/** A connection that behaves like a signed-in clinic user (see asUser). */
async function sessionAs(userId: string): Promise<pg.Client> {
  const client = await connect(database);
  await client.query("select set_config('request.jwt.claims', $1, false)", [JSON.stringify({ sub: userId })]);
  // Without this the session is a superuser and RLS is bypassed entirely.
  await client.query("set role authenticated");
  return client;
}

type Outcome = { ok: true } | { ok: false; code: string; detail: string };

function settle(p: Promise<unknown>): Promise<Outcome> {
  return p.then(
    () => ({ ok: true as const }),
    (e: { code?: string; detail?: string }) => ({ ok: false as const, code: e.code ?? "", detail: e.detail ?? "" }),
  );
}

/**
 * Wait until a backend is genuinely blocked on a lock, as reported by
 * PostgreSQL itself. Evidence, not a sleep: a test that sleeps 100 ms and
 * hopes the other session got there first passes or fails by timing luck.
 */
async function waitUntilBlocked(observer: pg.Client, pid: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const r = await observer.query<{ wait_event_type: string | null }>(
      "select wait_event_type from pg_stat_activity where pid = $1",
      [pid],
    );
    if (r.rows[0]?.wait_event_type === "Lock") return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`backend ${pid} never blocked on a lock`);
}

async function ledger(observer: pg.Client) {
  const b = await observer.query<{ q: number }>(
    "select quantity_on_hand as q from batches where id = $1", [BATCH_A_GOOD]);
  const m = await observer.query<{ issues: number; sum: number }>(
    `select count(*) filter (where movement_type = 'issue')::int as issues,
            coalesce(sum(quantity_delta), 0)::int as sum
       from stock_movements where batch_id = $1`, [BATCH_A_GOOD]);
  return { balance: b.rows[0].q, issues: m.rows[0].issues, deltaSum: m.rows[0].sum };
}

beforeAll(async () => {
  port = await freePort();
  dataDir = mkdtempSync(join(tmpdir(), "clinicstock-pg-"));
  server = new EmbeddedPostgres({
    databaseDir: dataDir, port, user: "postgres", password: PASSWORD, persistent: false,
  });
  await server.initialise();
  await server.start();

  // Build the schema ONCE into a template database. Each test then gets
  // CREATE DATABASE ... TEMPLATE, a file-level copy: perfect isolation at a
  // fraction of the cost of re-running migrations. (Roles are cluster-wide,
  // so the shim's CREATE ROLE runs only here.)
  const admin = await connect("postgres");
  await admin.query(`create database ${TEMPLATE}`);
  const t = await connect(TEMPLATE);
  await t.query(SUPABASE_SHIM);
  for (const sql of migrationSql()) await t.query(sql);
  await t.query(SEED);
  await t.end();
  open.splice(open.indexOf(t), 1);
}, 180_000);

beforeEach(async () => {
  database = `t_${process.pid}_${++counter}`;
  const admin = await connect("postgres");
  await admin.query(`create database ${database} template ${TEMPLATE}`);
});

afterEach(async () => {
  await Promise.all(open.splice(0).map((c) => c.end().catch(() => undefined)));
});

afterAll(async () => {
  await server?.stop();
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
}, 60_000);

describe("overlapping stock issues (real PostgreSQL, several connections)", () => {
  it("the starting state: 30 on hand, one receipt, invariant holds", async () => {
    const observer = await connect(database);
    expect(await ledger(observer)).toEqual({ balance: 30, issues: 0, deltaSum: 30 });
  });

  it("a second issue waits for the first, then is refused with the true balance", async () => {
    const a = await sessionAs(OFFICER_A);
    const b = await sessionAs(OFFICER_A);
    const observer = await connect(database);
    const bPid = (await b.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0].pid;

    // A issues 20 inside an open transaction: it now holds the batch row lock.
    await a.query("begin");
    await a.query("select issue_stock($1, 20, 'Ward usage')", [BATCH_A_GOOD]);

    // B asks for 20 too. Started, not awaited: it must block.
    const bOutcome = settle(b.query("select issue_stock($1, 20, 'Ward usage')", [BATCH_A_GOOD]));
    await waitUntilBlocked(observer, bPid);

    await a.query("commit");

    // B wakes, re-reads 10, and is refused by the business rule -- not by
    // a constraint at write time.
    expect(await bOutcome).toEqual({ ok: false, code: "P0001", detail: "INSUFFICIENT_STOCK" });
    expect(await ledger(observer)).toEqual({ balance: 10, issues: 1, deltaSum: 10 });
  });

  it("ten simultaneous issues of 5 from 30: exactly six succeed", async () => {
    const sessions = await Promise.all(Array.from({ length: 10 }, () => sessionAs(OFFICER_A)));
    const outcomes = await Promise.all(
      sessions.map((s) => settle(s.query("select issue_stock($1, 5, 'Ward usage')", [BATCH_A_GOOD]))),
    );

    const succeeded = outcomes.filter((o) => o.ok).length;
    const refused = outcomes.filter((o) => !o.ok);
    expect(succeeded).toBe(6);
    expect(refused).toHaveLength(4);
    for (const r of refused) expect(r).toEqual({ ok: false, code: "P0001", detail: "INSUFFICIENT_STOCK" });

    const observer = await connect(database);
    expect(await ledger(observer)).toEqual({ balance: 0, issues: 6, deltaSum: 0 });
  });

  it("CONTROL: without FOR UPDATE, the same race ends in a raw constraint error", async () => {
    // Proves the test above can fail, and shows what the lock actually buys.
    // Rewrite issue_stock in THIS test's database only, minus the lock.
    const admin = await connect(database);
    const def = (await admin.query<{ d: string }>(
      "select pg_get_functiondef('public.issue_stock(uuid, integer, text, text)'::regprocedure) as d",
    )).rows[0].d;
    const unlocked = def.replace(/\n\s*for update;/i, ";");
    expect(unlocked).not.toBe(def); // the edit really happened
    await admin.query(unlocked);

    const a = await sessionAs(OFFICER_A);
    const b = await sessionAs(OFFICER_A);
    const bPid = (await b.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0].pid;

    await a.query("begin");
    await a.query("select issue_stock($1, 20, 'Ward usage')", [BATCH_A_GOOD]);

    // B still blocks -- but at its UPDATE, after it has already validated 20
    // against the stale 30 it read.
    const bOutcome = settle(b.query("select issue_stock($1, 20, 'Ward usage')", [BATCH_A_GOOD]));
    await waitUntilBlocked(admin, bPid);
    await a.query("commit");

    const outcome = await bOutcome;
    expect(outcome).toEqual({ ok: false, code: "23514", detail: expect.any(String) });
    // The data is still right: the CHECK constraint was the last line.
    expect(await ledger(admin)).toEqual({ balance: 10, issues: 1, deltaSum: 10 });
  });
});
