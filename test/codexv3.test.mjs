// Mirror note: tests that need a signed Pro key are skipped here. The signing key
// lives only in the monorepo (keys/license-private.pem); run them there.
// Mirror note: tests that run a script from the monorepo's scripts/ directory are
// skipped here. That directory is not part of a server folder; run them in the monorepo.
// Codex v3 fixes: #1 corrupt store, #18 rate strings, #19 rate snapshot, #20 inclusive
// date-only bounds, #21/#22/#23 clipping and midnight splits, #24 explicit offsets,
// #26 tag totals, #27 mixed-currency JSON, #29 one project resolver everywhere.
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

test.skip("#1 P0: a corrupt data.json is quarantined byte-for-byte and every tool refuses to write", async (t) => {
  const sandbox = mkdtempSync(join(tmpdir(), "mcp-tt-v3-"));
  const dir = join(sandbox, "data", "mcp-servers", "time-tracker");
  mkdirSync(dir, { recursive: true });
  const GARBAGE = '{"version":1,"entries":[{"id":"aa","project":"acme"  <<< truncated by a crash';
  writeFileSync(join(dir, "data.json"), GARBAGE);

  const c = client({ MCP_LICENSE_KEY: PRO }, sandbox);
  t.after(() => c.close());
  await c.init();

  const mutate = await c.call("timer_start", { project: "acme" });
  assert.equal(mutate.isError, true, mutate.text);
  assert.match(mutate.text, /data file is corrupt; moved to .*\.corrupt-/);
  assert.match(mutate.text, /nothing was written/);

  const moved = readdirSync(dir).filter(f => f.includes(".corrupt-"));
  assert.equal(moved.length, 1, `expected one quarantined file, got ${JSON.stringify(readdirSync(dir))}`);
  assert.equal(readFileSync(join(dir, moved[0]), "utf8"), GARBAGE, "the original bytes must survive untouched");

  // and it stays refused - reads too - until a human clears the marker
  const read = await c.call("entry_list", {});
  assert.equal(read.isError, true, read.text);
  assert.match(read.text, /data file is corrupt/);
  const again = await c.call("entry_add", { project: "acme", start: `${localDay()}T09:00:00`, minutes: 60 });
  assert.equal(again.isError, true, again.text);
  assert.equal(readdirSync(dir).filter(f => f === "data.json").length, 0, "no empty database was written over the corrupt one");
});

test.skip("#18: rate strings - 1,200 USD is 1200, 12,50 EUR is 12.50, 1,2345 is refused", async (t) => {
  const c = client({ MCP_LICENSE_KEY: PRO });
  t.after(() => c.close());
  await c.init();
  const day = localDay();

  const thousand = await c.call("entry_add", { project: "grouped", start: `${day}T09:00:00`, minutes: 60, rate: "1,200 USD" });
  assert.equal(thousand.isError, false, thousand.text);
  assert.match(thousand.text, /USD 1200\.00\/h/);

  const euro = await c.call("entry_add", { project: "euro", start: `${day}T09:00:00`, minutes: 60, rate: "12,50 EUR" });
  assert.match(euro.text, /EUR 12\.50\/h/);

  const both = await c.call("project_set_rate", { project: "mixed", hourly_rate: "1.200,50 EUR" });
  assert.match(both.text, /EUR 1200\.50 per hour/);

  const bad = await c.call("project_set_rate", { project: "unclear", hourly_rate: "1,2345 USD" });
  assert.equal(bad.isError, true, bad.text);
  assert.match(bad.text, /ambiguous/);
  assert.match(bad.text, /1,200\.00/, "the refusal must show a worked example");
});

test.skip("#19/#29: the rate is captured at entry time and project_set_rate is future-only", async (t) => {
  const c = client({ MCP_LICENSE_KEY: PRO });
  t.after(() => c.close());
  await c.init();
  const day = localDay();

  await c.call("project_set_rate", { project: "Acme Web", hourly_rate: 50, currency: "USD" });
  const add = await c.call("entry_add", { project: "Acme Web", start: `${day}T09:00:00`, minutes: 60 });
  assert.match(add.text, /USD 50\.00/);

  const changed = await c.call("project_set_rate", { project: "Acme Web", hourly_rate: 100, currency: "EUR" });
  assert.match(changed.text, /future entries only/);

  const rep = await c.call("report", { from: `${day}T00:00:00`, to: `${day}T23:59:59`, group_by: "project", format: "json" });
  const json = JSON.parse(rep.text);
  assert.equal(json.rows[0].amount_cents, 5000, rep.text);
  assert.equal(json.rows[0].currency, "USD", "the historical entry keeps the rate it was logged at");

  // #29: reporting resolves projects exactly like creation does
  await c.call("project_set_rate", { project: "Acme Mobile", hourly_rate: 60, currency: "USD" });
  const amb = await c.call("invoice_summary", { project: "Acme", from: `${day}T00:00:00`, to: `${day}T23:59:59` });
  assert.match(amb.text, /matches 2 existing projects/);
  const ambReport = await c.call("report", { from: `${day}T00:00:00`, to: `${day}T23:59:59`, group_by: "project", project: "Acme" });
  assert.match(ambReport.text, /matches 2 existing projects/);
});

test.skip("#20/#21/#22/#24: date-only bounds are inclusive, entries are clipped and split at local midnight", async (t) => {
  const c = client({ MCP_LICENSE_KEY: PRO });
  t.after(() => c.close());
  await c.init();

  // month boundary, 23:30 -> 01:30 local, offsetless (= local, #24)
  const add = await c.call("entry_add", { project: "night", start: "2026-03-31T23:30:00", end: "2026-04-01T01:30:00", rate: 60, currency: "USD" });
  assert.equal(add.isError, false, add.text);
  assert.match(add.text, /2\.00 h/);

  // #20: a date-only `to` covers the whole of that day; #21: only the part inside it counts
  const march = JSON.parse((await c.call("report", { from: "2026-03-01", to: "2026-03-31", group_by: "day", format: "json" })).text);
  assert.equal(march.total.seconds, 1800, "March gets the 30 minutes before midnight");
  assert.equal(march.rows.length, 1);
  assert.equal(march.rows[0].key, "2026-03-31");

  // #22: the same entry is split, the rest lands on 1 April
  const both = JSON.parse((await c.call("report", { from: "2026-03-01", to: "2026-04-30", group_by: "day", format: "json" })).text);
  const byDay = Object.fromEntries(both.rows.map(r => [r.key, r.seconds]));
  assert.equal(byDay["2026-03-31"], 1800);
  assert.equal(byDay["2026-04-01"], 5400);
  assert.equal(both.total.seconds, 7200, "the total counts the entry once");
  assert.equal(both.total.amount_cents, 12000, "2 h at USD 60.00");

  // #24: an explicit offset is honoured, not reinterpreted in the server timezone
  const off = await c.call("entry_add", { project: "offset", start: "2026-05-05T00:30:00+02:00", end: "2026-05-05T01:30:00+02:00", rate: 10, currency: "USD" });
  assert.equal(off.isError, false, off.text);
  const utc = JSON.parse((await c.call("report", { from: "2026-05-04T22:30:00Z", to: "2026-05-04T23:30:00Z", group_by: "project", format: "json", project: "offset" })).text);
  assert.equal(utc.total.seconds, 3600, "the entry sits at 22:30 UTC because +02:00 was honoured");
});

test.skip("#23: today counts only the part of an entry that falls after local midnight", async (t) => {
  const c = client({ MCP_LICENSE_KEY: PRO });
  t.after(() => c.close());
  await c.init();
  const yesterday = localDay(new Date(Date.now() - 86400e3));
  const today = localDay();
  await c.call("entry_add", { project: "night", start: `${yesterday}T23:00:00`, end: `${today}T00:30:00` });
  const st = await c.call("timer_status", {});
  assert.match(st.text, /Today: 00:30:00 \(0\.50 h\)/, st.text);
});

test.skip("#26/#27: tag totals count each entry once and mixed currencies expose no scalar amount", async (t) => {
  const c = client({ MCP_LICENSE_KEY: PRO });
  t.after(() => c.close());
  await c.init();
  const day = localDay();
  await c.call("entry_add", { project: "acme", start: `${day}T09:00:00`, minutes: 60, tags: ["a", "b"], rate: 100, currency: "USD" });
  await c.call("entry_add", { project: "acme", start: `${day}T11:00:00`, minutes: 60, tags: ["c"], rate: 90, currency: "EUR" });

  const j = JSON.parse((await c.call("report", { from: `${day}T00:00:00`, to: `${day}T23:59:59`, group_by: "tag", format: "json" })).text);
  assert.equal(j.total.seconds, 7200, "two hours, not three: tag buckets overlap");
  assert.equal(j.total.amount_cents, undefined, "#27: no scalar amount for a mixed-currency total");
  assert.equal(j.total.currency, undefined);
  assert.deepEqual(j.total.amounts.map(a => a.currency).sort(), ["EUR", "USD"]);
  assert.match(j.note, /overlap/);

  const tbl = await c.call("report", { from: `${day}T00:00:00`, to: `${day}T23:59:59`, group_by: "tag", format: "table" });
  assert.match(tbl.text, /Total 2\.00 h, USD 100\.00 \+ EUR 90\.00\./);
  assert.match(tbl.text, /can overlap/);
});
