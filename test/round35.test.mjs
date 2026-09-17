// Loop 35, defect ledger D-R68 (docs/USER_VALUE_R13.md): on the free tier a requested
// window that lies entirely before the 7-day floor used to read identically to an empty
// month - "No entries found" plus "the free tier shows the last 7 days". One says nothing
// was logged, the other says nothing was read. The unread window must now say so.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ENTRY = join(here, "..", "dist", "index.js");

function client(env = {}, sandbox = mkdtempSync(join(tmpdir(), "mcp-tt-r35-"))) {
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
    async call(name, args) {
      const r = await send("tools/call", { name, arguments: args ?? {} });
      assert.ok(r.result, `tools/call ${name} returned ${JSON.stringify(r.error)}`);
      return { text: r.result.content.map(c => c.text).join("\n"), isError: r.result.isError === true };
    },
    async init() {
      await send("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "r35", version: "0" } });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }) + "\n");
    },
    close() { child.kill(); try { rmSync(sandbox, { recursive: true, force: true }); } catch {} },
  };
}

test("D-R68: entry_list over a window entirely older than the free tier says nothing was read", async (t) => {
  const c = client(); t.after(() => c.close());
  await c.init();
  await c.call("entry_add", { project: "acme", task: "spec", start: "2026-09-10T09:00:00", minutes: 60 });
  const r = await c.call("entry_list", { from: "2020-01-01", to: "2020-01-31" });
  assert.ok(!r.isError, r.text);
  assert.match(r.text, /Nothing was read/);
  assert.match(r.text, /unread, not empty/);
  assert.doesNotMatch(r.text, /No entries found/);
});

test("D-R68: a clamped window that DOES intersect the free tier keeps the old note", async (t) => {
  const c = client(); t.after(() => c.close());
  await c.init();
  await c.call("entry_add", { project: "acme", task: "spec", start: "2026-09-10T09:00:00", minutes: 60 });
  const r = await c.call("entry_list", { from: "2020-01-01" });
  assert.ok(!r.isError, r.text);
  assert.match(r.text, /free tier shows the last 7 days/);
  assert.doesNotMatch(r.text, /Nothing was read/);
});

test("D-R68: report over an unread window names it instead of a bare zero total", async (t) => {
  const c = client(); t.after(() => c.close());
  await c.init();
  await c.call("entry_add", { project: "acme", task: "spec", start: "2026-09-10T09:00:00", minutes: 60 });
  const r = await c.call("report", { from: "2020-01-01", to: "2020-01-31" });
  assert.ok(!r.isError, r.text);
  assert.match(r.text, /Nothing was read/);
  assert.doesNotMatch(r.text, /free tier shows the last 7 days/);
});

test("D-R68: export_csv over an unread window names it on the written file's line", async (t) => {
  const c = client(); t.after(() => c.close());
  await c.init();
  const r = await c.call("export_csv", { from: "2020-01-01", to: "2020-01-31" });
  assert.ok(!r.isError, r.text);
  assert.match(r.text, /Wrote 0 entries/);
  assert.match(r.text, /Nothing was read/);
});
