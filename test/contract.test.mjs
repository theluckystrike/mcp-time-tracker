// Mirror note: tests that need a signed Pro key are skipped here. The signing key
// lives only in the monorepo (keys/license-private.pem); run them there.
// Mirror note: tests that run a script from the monorepo's scripts/ directory are
// skipped here. That directory is not part of a server folder; run them in the monorepo.
// Contract suite for time-tracker. Generated shape, mechanical assertions only.
//
// Asserts the invariants of servers/time-tracker/SPEC.md that a test can check without
// judgement: JSON-RPC-only stdout, tool-description hygiene, corrupt-store quarantine,
// no partial file on a write cap, and the free/Pro tier switch. It never asserts a
// number a human chose; those live in the server's own suites.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ENTRY = join(here, "..", "dist", "index.js");
const REPO = join(here, "..");
const PRODUCT = "time-tracker";

const MAX_DESCRIPTION = 220;
const HARD_MAX_DESCRIPTION = 1200;
const FILE_ARGS = ["path", "url", "out_path", "template_path"];
const IMPERATIVE = /^(Call this tool|Use this)\b/;

/**
 * Tools that already break the two description rules on the day this suite was written.
 * The suite is a ratchet: an existing entry is reported, a NEW one fails. Both lists are
 * defects, tracked in docs/SPEC_RESULT.md; the fix is in src, not here.
 */
const OVER_LENGTH_BASELINE = [];
const NON_IMPERATIVE_BASELINE = [];

const GARBAGE = '{"version":1, <<< truncated by a crash';

function client(env = {}) {
  const home = mkdtempSync(join(tmpdir(), "mcp-contract-time-tracker-"));
  const child = spawn(process.execPath, [ENTRY], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      XDG_DATA_HOME: join(home, "data"),
      XDG_CONFIG_HOME: join(home, "config"),
      MCP_LICENSE_KEY: "",
      ...env,
    },
  });
  child.stderr.resume();
  const stdoutLines = [];
  let buf = "";
  const pending = new Map();
  child.stdout.on("data", (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      stdoutLines.push(line);
      const t = line.trim();
      if (!t) continue;
      let m;
      try { m = JSON.parse(t); } catch { continue; }
      const r = pending.get(m.id);
      if (r) { pending.delete(m.id); r(m); }
    }
  });
  let id = 0;
  const send = (method, params) => new Promise((res, rej) => {
    const mid = ++id;
    pending.set(mid, res);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: mid, method, params }) + "\n");
    const t = setTimeout(() => { if (pending.has(mid)) { pending.delete(mid); rej(new Error(`timeout on ${method}`)); } }, 30000);
    t.unref();
  });
  return {
    home, send, stdoutLines,
    get tail() { return buf; },
    async init() {
      const r = await send("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "contract", version: "0" } });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }) + "\n");
      return r.result;
    },
    async tools() { return (await send("tools/list", {})).result.tools; },
    async call(name, args) {
      const r = await send("tools/call", { name, arguments: args ?? {} });
      if (!r.result) return { text: JSON.stringify(r.error), isError: true };
      return { text: r.result.content.map((x) => x.text).join("\n"), isError: r.result.isError === true };
    },
    close() { child.kill(); try { rmSync(home, { recursive: true, force: true }); } catch { /* best effort */ } },
  };
}

test("stdout carries JSON-RPC only across initialize, tools/list and one call", async (t) => {
  const c = client();
  t.after(() => c.close());
  await c.init();
  await c.tools();
  await c.call("timer_status", {});
  await new Promise((r) => setTimeout(r, 150));

  const lines = [...c.stdoutLines, c.tail].filter((l) => l.trim() !== "");
  assert.ok(lines.length >= 3, `expected at least 3 protocol lines, got ${lines.length}`);
  for (const line of lines) {
    let m;
    try { m = JSON.parse(line); } catch {
      assert.fail(`non-JSON on stdout: ${JSON.stringify(line.slice(0, 200))}`);
    }
    assert.equal(m.jsonrpc, "2.0", `stdout line is JSON but not JSON-RPC: ${line.slice(0, 200)}`);
  }
});

test("every tool description is non-empty, single-paragraph, and within the hard ceiling", async (t) => {
  const c = client();
  t.after(() => c.close());
  await c.init();
  const tools = await c.tools();
  assert.equal(tools.length, 14, "tool count changed; regenerate SPEC.md with scripts/gen-spec.mjs");

  for (const tool of tools) {
    const d = tool.description ?? "";
    assert.ok(d.trim().length > 0, `${tool.name} has no description`);
    assert.equal(d, d.trim(), `${tool.name} description has leading or trailing whitespace`);
    assert.ok(d.length <= HARD_MAX_DESCRIPTION, `${tool.name} description is ${d.length} chars, over the hard ceiling ${HARD_MAX_DESCRIPTION}`);
    assert.ok(!/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(d), `${tool.name} description carries an emoji`);
  }

  const over = tools.filter((x) => (x.description ?? "").length > MAX_DESCRIPTION).map((x) => x.name).sort();
  const regressions = over.filter((n) => !OVER_LENGTH_BASELINE.includes(n));
  assert.deepEqual(regressions, [], `new tool descriptions over ${MAX_DESCRIPTION} chars`);
  const fixed = OVER_LENGTH_BASELINE.filter((n) => !over.includes(n));
  if (fixed.length) t.diagnostic(`now within ${MAX_DESCRIPTION} chars, drop from the baseline: ${fixed.join(", ")}`);
});

test("a tool that takes a file path or a URL opens with an imperative sentence", async (t) => {
  const c = client();
  t.after(() => c.close());
  await c.init();
  const tools = await c.tools();

  const fileTools = tools.filter((x) => Object.keys(x.inputSchema?.properties ?? {}).some((k) => FILE_ARGS.includes(k)));
  const offenders = fileTools.filter((x) => !IMPERATIVE.test(x.description ?? "")).map((x) => x.name).sort();
  const regressions = offenders.filter((n) => !NON_IMPERATIVE_BASELINE.includes(n));
  assert.deepEqual(regressions, [], "new file/URL tools whose description does not start with \"Call this tool\" or \"Use this\"");
  const fixed = NON_IMPERATIVE_BASELINE.filter((n) => !offenders.includes(n));
  if (fixed.length) t.diagnostic(`now imperative, drop from the baseline: ${fixed.join(", ")}`);
});

test("corrupt store: the garbage is quarantined byte-for-byte and nothing is overwritten", async (t) => {
  const c = client();
  t.after(() => c.close());

  const dir = join(c.home, "data", "mcp-servers", "time-tracker");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "data.json"), GARBAGE);

  await c.init();
  const r = await c.call("entry_add", {"project":"P","start":"2026-01-05T09:00","minutes":60});
  assert.equal(r.isError, true, `a corrupt store must refuse, not succeed: ${r.text.slice(0, 300)}`);
  assert.match(r.text, /corrupt|not valid JSON/i, r.text.slice(0, 300));

  const moved = readdirSync(dir).filter((f) => f.startsWith("data.json.corrupt-"));
  assert.equal(moved.length, 1, `expected one quarantined copy, found ${JSON.stringify(readdirSync(dir))}`);
  assert.equal(readFileSync(join(dir, moved[0]), "utf8"), GARBAGE, "the quarantined copy must be the original bytes");
  assert.equal(readdirSync(dir).includes("data.json"), false, "an empty store must not be written over the corrupt one");
});

test.skip("cap: no row-capped write tool on this server", { skip: "time-tracker has no row cap on a written file; its free limits are counts of stored records, covered by the server's own suites" }, () => {});

test.skip("license_status reports free with no key and pro with a signed key", async (t) => {
  const free = client();
  t.after(() => free.close());
  await free.init();
  const f = await free.call("license_status", {});
  assert.equal(f.isError, false, f.text);
  assert.match(f.text, /"tier":\s*"free"/, f.text.slice(0, 300));

  const key = execFileSync(process.execPath, [join(REPO, "scripts", "sign-license.mjs"), PRODUCT], { encoding: "utf8" }).trim();
  assert.match(key, /^MCPL1\./);

  const pro = client({ MCP_LICENSE_KEY: key });
  t.after(() => pro.close());
  await pro.init();
  const p = await pro.call("license_status", {});
  assert.equal(p.isError, false, p.text);
  assert.match(p.text, /"tier":\s*"pro"/, p.text.slice(0, 300));

  // A key signed for another product must not unlock this one.
  const foreign = execFileSync(process.execPath, [join(REPO, "scripts", "sign-license.mjs"), "not-a-real-product"], { encoding: "utf8" }).trim();
  const other = client({ MCP_LICENSE_KEY: foreign });
  t.after(() => other.close());
  await other.init();
  const o = await other.call("license_status", {});
  assert.match(o.text, /"tier":\s*"free"/, o.text.slice(0, 300));
});
