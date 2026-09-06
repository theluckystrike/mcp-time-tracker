// Mirror note: tests that need a signed Pro key are skipped here. The signing key
// lives only in the monorepo (keys/license-private.pem); run them there.
// Mirror note: tests that run a script from the monorepo's scripts/ directory are
// skipped here. That directory is not part of a server folder; run them in the monorepo.
// Round-6 fixes (docs/USER_VALUE_R6.md): D-R18 apply_to_existing re-rates every entry,
// D-R22 tag grouping is free and group_by is optional, D-R23 the .corrupt marker is
// self-describing JSON.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ENTRY = join(here, "..", "dist", "index.js");
const REPO = join(here, "..");
const PRO = "";

function client(env = {}, sandbox = mkdtempSync(join(tmpdir(), "mcp-tt-v3-"))) {
  const child = spawn(process.execPath, [ENTRY], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, XDG_DATA_HOME: join(sandbox, "data"), XDG_CONFIG_HOME: join(sandbox, "config"), MCP_LICENSE_KEY: "", ...env },
  });
  let buf = "";
  const pending = new Map();
  child.stdout.on("data", chunk => {
    buf += chunk.toString();
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      const r = pending.get(msg.id);
      if (r) { pending.delete(msg.id); r(msg); }
    }
  });
  let id = 0;
  const send = (method, params) => new Promise((res, rej) => {
    const mid = ++id;
    pending.set(mid, res);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: mid, method, params }) + "\n");
    const t = setTimeout(() => { if (pending.has(mid)) { pending.delete(mid); rej(new Error(`timeout on ${method}`)); } }, 10000);
    t.unref();
  });
  return {
    sandbox,
    dataDir: join(sandbox, "data", "mcp-servers", "time-tracker"),
    async call(name, args) {
      const r = await send("tools/call", { name, arguments: args ?? {} });
      assert.ok(r.result, `tools/call ${name} returned ${JSON.stringify(r.error)}`);
      return { text: r.result.content.map(c => c.text).join("\n"), isError: r.result.isError === true };
    },
    async init() {
      await send("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "v3", version: "0" } });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }) + "\n");
    },
    close() { child.kill(); try { rmSync(sandbox, { recursive: true, force: true }); } catch {} },
  };
}

const pad = n => String(n).padStart(2, "0");
const localDay = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

test.skip("D-R18: apply_to_existing re-rates EVERY entry of the project and reports the new total", async (t) => {
  const c = client({ MCP_LICENSE_KEY: PRO });
  t.after(() => c.close());
  await c.init();
  const today = localDay();

  await c.call("project_set_rate", { project: "Nova", hourly_rate: 100, currency: "USD" });
  await c.call("entry_add", { project: "Nova", task: "a", start: `${today}T09:00:00`, minutes: 120 });
  await c.call("entry_add", { project: "Nova", task: "b", start: `${today}T13:00:00`, minutes: 60 });

  const before = await c.call("report", { from: `${today}T00:00:00`, to: `${today}T23:59:59`, group_by: "project" });
  assert.match(before.text, /USD 300\.00/);

  const set = await c.call("project_set_rate", { project: "Nova", hourly_rate: 120, currency: "USD", apply_to_existing: true });
  assert.equal(set.isError, false, set.text);
  assert.match(set.text, /2 of 2 already logged entries re-rated \(only_missing: false\)/);
  assert.match(set.text, /New total for "Nova": 3\.00 h, USD 360\.00/);

  const after = await c.call("report", { from: `${today}T00:00:00`, to: `${today}T23:59:59`, group_by: "project" });
  assert.match(after.text, /USD 360\.00/);
});

test.skip("D-R18: only_missing keeps the old fill-the-gaps behaviour on a legacy store", async (t) => {
  // Entries written by this version always capture a rate (Codex v3 #19), so the only
  // entries only_missing can touch are legacy ones. Build that store on disk.
  const sandbox = mkdtempSync(join(tmpdir(), "mcp-tt-r6-"));
  const dir = join(sandbox, "data", "mcp-servers", "time-tracker");
  mkdirSync(dir, { recursive: true });
  const today = localDay();
  writeFileSync(join(dir, "data.json"), JSON.stringify({
    version: 1,
    projects: {},
    entries: [
      { id: "rated", project: "Nova", task: "rated", tags: [], start: `${today}T09:00:00.000Z`, end: `${today}T10:00:00.000Z`, seconds: 3600, billable: true, rateCents: 10000, currency: "USD" },
      { id: "bare", project: "Nova", task: "bare", tags: [], start: `${today}T11:00:00.000Z`, end: `${today}T12:00:00.000Z`, seconds: 3600, billable: true },
    ],
  }));

  const c = client({ MCP_LICENSE_KEY: PRO }, sandbox);
  t.after(() => c.close());
  await c.init();

  const om = await c.call("project_set_rate", { project: "Nova", hourly_rate: 200, currency: "USD", apply_to_existing: true, only_missing: true });
  assert.equal(om.isError, false, om.text);
  assert.match(om.text, /1 of 2 entries that had no rate of their own re-rated \(only_missing: true\)/);
  // the entry that carried USD 100 was not touched: 100 + 200 = USD 300.00
  assert.match(om.text, /New total for "Nova": 2\.00 h, USD 300\.00/);

  // without only_missing the same call re-stamps both
  const all = await c.call("project_set_rate", { project: "Nova", hourly_rate: 50, currency: "USD", apply_to_existing: true });
  assert.match(all.text, /2 of 2 already logged entries re-rated \(only_missing: false\)/);
  assert.match(all.text, /New total for "Nova": 2\.00 h, USD 100\.00/);
});

test.skip("D-R22: tag grouping is free, and group_by is optional", async (t) => {
  const c = client({ MCP_LICENSE_KEY: "" });   // free tier
  t.after(() => c.close());
  await c.init();
  const today = localDay();

  await c.call("project_set_rate", { project: "Nova", hourly_rate: 120, currency: "USD" });
  await c.call("entry_add", { project: "Nova", task: "a", start: `${today}T09:00:00`, minutes: 180, tags: ["review", "demo"] });
  await c.call("entry_add", { project: "Nova", task: "b", start: `${today}T13:00:00`, minutes: 120, tags: ["review"] });

  const tag = await c.call("report", { from: `${today}T00:00:00`, to: `${today}T23:59:59`, group_by: "tag", format: "json" });
  assert.equal(tag.isError, false, tag.text);
  assert.doesNotMatch(tag.text, /mcp\.zovo\.one/);
  const parsed = JSON.parse(tag.text.split("\n\nNote:")[0]);
  assert.equal(parsed.tier, "free");
  const rows = Object.fromEntries(parsed.rows.map(r => [r.key, r.amount_cents]));
  assert.equal(rows.review, 60000);
  assert.equal(rows.demo, 36000);
  assert.equal(parsed.total.amount_cents, 60000);   // each entry counted once
  assert.match(parsed.note, /Tag rows can overlap/);

  const plain = await c.call("report", { from: `${today}T00:00:00`, to: `${today}T23:59:59` });
  assert.equal(plain.isError, false, plain.text);
  assert.equal(plain.text.trim(), "Total 5.00 h, USD 600.00.");

  const plainJson = await c.call("report", { from: `${today}T00:00:00`, to: `${today}T23:59:59`, format: "json" });
  const pj = JSON.parse(plainJson.text.split("\n\nNote:")[0]);
  assert.equal(pj.group_by, null);
  assert.deepEqual(pj.rows, []);
  assert.equal(pj.total.amount_cents, 60000);
});

test.skip("D-R23: the .corrupt marker holds self-describing one-line JSON", async (t) => {
  const sandbox = mkdtempSync(join(tmpdir(), "mcp-tt-r6-"));
  const dir = join(sandbox, "data", "mcp-servers", "time-tracker");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "data.json"), '{"entries":[{"id":"a","start');

  const c = client({ MCP_LICENSE_KEY: PRO }, sandbox);
  t.after(() => c.close());
  await c.init();
  const r = await c.call("timer_start", { project: "Nova" });
  assert.equal(r.isError, true, r.text);

  const raw = readFileSync(join(dir, "data.json.corrupt"), "utf8");
  assert.equal(raw.trim().split("\n").length, 1, `marker must be one line, got ${JSON.stringify(raw)}`);
  const m = JSON.parse(raw);
  assert.deepEqual(Object.keys(m).sort(), ["at", "hint", "quarantined"]);
  assert.match(m.quarantined, /data\.json\.corrupt-/);
  assert.ok(!Number.isNaN(Date.parse(m.at)), `at must be an ISO timestamp, got ${m.at}`);
  assert.equal(m.hint, "the original data file failed to parse; it was moved, nothing was overwritten; restore it manually or delete this marker to start fresh");

  // the marker keeps every later call blocked, and the quarantine path is read back out of it
  const again = await c.call("timer_start", { project: "Nova" });
  assert.equal(again.isError, true);
  assert.match(again.text, new RegExp(m.quarantined.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});
