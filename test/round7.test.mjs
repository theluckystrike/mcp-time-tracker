// Mirror note: tests that need a signed Pro key are skipped here. The signing key
// lives only in the monorepo (keys/license-private.pem); run them there.
// Mirror note: tests that run a script from the monorepo's scripts/ directory are
// skipped here. That directory is not part of a server folder; run them in the monorepo.
// Round-7 fix (docs/USER_VALUE_R7.md): D-R28 - hours put on an invoice are stamped by
// entry_mark_billed and disappear from invoice_summary and report until unbilled_only:false.
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

function client(env = {}, sandbox = mkdtempSync(join(tmpdir(), "mcp-tt-r7-"))) {
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
      await send("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "r7", version: "0" } });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }) + "\n");
    },
    close() { child.kill(); try { rmSync(sandbox, { recursive: true, force: true }); } catch {} },
  };
}

const pad = n => String(n).padStart(2, "0");
const localDay = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;


test.skip("D-R28: hours billed once are excluded from the next invoice_summary", async (t) => {
  const c = client({ MCP_LICENSE_KEY: PRO });
  t.after(() => c.close());
  await c.init();
  const today = localDay();
  const from = `${today}T00:00:00`, to = `${today}T23:59:59`;

  await c.call("project_set_rate", { project: "Nova", hourly_rate: 90, currency: "EUR" });
  await c.call("entry_add", { project: "Nova", task: "build", start: `${today}T09:00:00`, minutes: 240 });
  await c.call("entry_add", { project: "Nova", task: "build", start: `${today}T14:00:00`, minutes: 120 });

  const first = await c.call("invoice_summary", { project: "Nova", from, to });
  assert.match(first.text, /TOTAL 6\.00 h {2}EUR 540\.00/);
  const ids = JSON.parse(first.text.match(/entry_ids: (\[[^\]]*\])/)[1]);
  assert.equal(ids.length, 2);
  assert.match(first.text, /call entry_mark_billed \{ids: <these entry_ids>, invoice_number: "<the new invoice number>"\}/);

  const marked = await c.call("entry_mark_billed", { ids, invoice_number: "INV-2026-0001" });
  assert.equal(marked.isError, false, marked.text);
  assert.match(marked.text, /Marked 2 entries as billed on INV-2026-0001: 6\.00 h, EUR 540\.00\./);

  // the same hours cannot be offered again
  const second = await c.call("invoice_summary", { project: "Nova", from, to });
  assert.match(second.text, /No billable time for "Nova" in that period\./);
  assert.match(second.text, /2 entries are hidden because they have already been invoiced\. Pass unbilled_only: false to include them\./);

  // unless the caller asks for everything
  const all = await c.call("invoice_summary", { project: "Nova", from, to, unbilled_only: false });
  assert.match(all.text, /TOTAL 6\.00 h {2}EUR 540\.00/);

  // a new entry after the invoice is billable again, on its own
  await c.call("entry_add", { project: "Nova", task: "review", start: `${today}T17:00:00`, minutes: 60 });
  const third = await c.call("invoice_summary", { project: "Nova", from, to });
  assert.match(third.text, /TOTAL 1\.00 h {2}EUR 90\.00/);
  assert.equal(JSON.parse(third.text.match(/entry_ids: (\[[^\]]*\])/)[1]).length, 1);

  // re-marking is idempotent: the already-billed entries are listed, not re-stamped
  const again = await c.call("entry_mark_billed", { ids, invoice_number: "INV-2026-0002" });
  assert.match(again.text, /Marked 0 entries as billed on INV-2026-0002/);
  assert.match(again.text, /Left alone, already billed: .*on INV-2026-0001/);
});

test.skip("D-R28: report hides billed hours by default and shows them on unbilled_only false", async (t) => {
  const c = client({ MCP_LICENSE_KEY: PRO });
  t.after(() => c.close());
  await c.init();
  const today = localDay();
  const from = `${today}T00:00:00`, to = `${today}T23:59:59`;

  await c.call("project_set_rate", { project: "Nova", hourly_rate: 90, currency: "EUR" });
  await c.call("entry_add", { project: "Nova", task: "build", start: `${today}T09:00:00`, minutes: 240 });
  await c.call("entry_add", { project: "Nova", task: "review", start: `${today}T14:00:00`, minutes: 120 });

  // mark by project + range instead of ids
  const marked = await c.call("entry_mark_billed", { project: "Nova", from, to, invoice_number: "INV-2026-0001" });
  assert.match(marked.text, /Marked 2 entries as billed on INV-2026-0001: 6\.00 h, EUR 540\.00\./);

  const r = await c.call("report", { from, to, group_by: "project" });
  assert.match(r.text, /No time tracked in that period\./);
  assert.match(r.text, /2 entries are hidden because they have already been invoiced\./);

  const full = await c.call("report", { from, to, group_by: "project", format: "json", unbilled_only: false });
  const j = JSON.parse(full.text);
  assert.equal(j.unbilled_only, false);
  assert.equal(j.billed_entries_excluded, 0);
  assert.equal(j.total.hours, 6);

  const def = JSON.parse((await c.call("report", { from, to, format: "json" })).text.split("\n\n")[0]);
  assert.equal(def.unbilled_only, true);
  assert.equal(def.billed_entries_excluded, 2);
  assert.equal(def.total.hours, 0);
});

test.skip("D-R28: entry_mark_billed refuses an unknown id and marks nothing", async (t) => {
  const c = client({ MCP_LICENSE_KEY: PRO });
  t.after(() => c.close());
  await c.init();
  const today = localDay();
  await c.call("project_set_rate", { project: "Nova", hourly_rate: 90, currency: "EUR" });
  await c.call("entry_add", { project: "Nova", start: `${today}T09:00:00`, minutes: 60 });
  const sum = await c.call("invoice_summary", { project: "Nova", from: `${today}T00:00:00`, to: `${today}T23:59:59` });
  const ids = JSON.parse(sum.text.match(/entry_ids: (\[[^\]]*\])/)[1]);

  const bad = await c.call("entry_mark_billed", { ids: [...ids, "nope"], invoice_number: "INV-2026-0001" });
  assert.equal(bad.isError, true, bad.text);
  assert.match(bad.text, /no entry with id nope/);
  // nothing was stamped: the hour is still on offer
  const after = await c.call("invoice_summary", { project: "Nova", from: `${today}T00:00:00`, to: `${today}T23:59:59` });
  assert.match(after.text, /TOTAL 1\.00 h/);

  const neither = await c.call("entry_mark_billed", { invoice_number: "INV-2026-0001" });
  assert.equal(neither.isError, true, neither.text);
  assert.match(neither.text, /pass either ids/);
});
