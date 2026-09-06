// Round 17, docs/USER_VALUE_R17.md, D-R85: an empty store must read as "nothing logged
// yet, entry_add creates a project automatically" rather than a bare "No entries found",
// which reads to a model as "this does not exist, ask before writing".
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ENTRY = join(here, "..", "dist", "index.js");

function client(env = {}, sandbox = mkdtempSync(join(tmpdir(), "mcp-tt-r17-"))) {
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
      await send("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "r17", version: "0" } });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }) + "\n");
    },
    close() { child.kill(); try { rmSync(sandbox, { recursive: true, force: true }); } catch {} },
  };
}

test("D-R85: an empty entry_list says entry_add creates the project automatically", async (t) => {
  const c = client(); t.after(() => c.close());
  await c.init();
  const r = await c.call("entry_list", {});
  assert.ok(!r.isError, r.text);
  assert.match(r.text, /No time entries logged yet/);
  assert.match(r.text, /entry_add creates the project.*automatically/);
});

test("D-R85: a filtered-empty entry_list is worded differently from a truly empty store", async (t) => {
  const c = client(); t.after(() => c.close());
  await c.init();
  await c.call("entry_add", { project: "Nova design", start: "2026-09-05T09:00:00", minutes: 60 });
  const r = await c.call("entry_list", { project: "no-such-project" });
  assert.ok(!r.isError, r.text);
  assert.match(r.text, /No entries found for that filter/);
  assert.doesNotMatch(r.text, /No time entries logged yet/);
});
