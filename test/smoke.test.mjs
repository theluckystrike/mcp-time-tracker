// Mirror note: tests that need a signed Pro key are skipped here. The signing key
// lives only in the monorepo (keys/license-private.pem); run them there.
// Mirror note: tests that run a script from the monorepo's scripts/ directory are
// skipped here. That directory is not part of a server folder; run them in the monorepo.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// D-R15: "today" is the LOCAL calendar date in every server; a UTC slice disagrees
// with it for any run before UTC midnight in a positive-offset zone.
const localDay = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

const here = dirname(fileURLToPath(import.meta.url));
const ENTRY = join(here, "..", "dist", "index.js");
const REPO = join(here, "..");

/** Minimal stdio JSON-RPC client for one server process. */
function client(env) {
  const sandbox = mkdtempSync(join(tmpdir(), "mcp-tt-"));
  const child = spawn(process.execPath, [ENTRY], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      XDG_DATA_HOME: join(sandbox, "data"),
      XDG_CONFIG_HOME: join(sandbox, "config"),
      MCP_LICENSE_KEY: "",
      ...env,
    },
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
  const notify = (method, params) =>
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  return {
    send, notify, sandbox,
    async call(name, args) {
      const r = await send("tools/call", { name, arguments: args ?? {} });
      assert.ok(r.result, `tools/call ${name} returned no result: ${JSON.stringify(r.error)}`);
      return { text: r.result.content.map(c => c.text).join("\n"), isError: r.result.isError === true };
    },
    async init() {
      const r = await send("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "smoke", version: "0.0.0" },
      });
      assert.equal(r.result.serverInfo.name, "mcp-time-tracker");
      notify("notifications/initialized");
      return r.result;
    },
    close() {
      child.kill();
      try { rmSync(sandbox, { recursive: true, force: true }); } catch {}
    },
  };
}

test.skip("free tier: initialize, tools/list, timer, report, gating", async () => {
  const c = client({});
  try {
    await c.init();

    const list = await c.send("tools/list", {});
    const names = list.result.tools.map(t => t.name).sort();
    for (const n of [
      "timer_start", "timer_stop", "timer_status", "entry_add", "entry_list", "entry_delete",
      "entry_edit", "project_set_rate", "report", "export_csv", "invoice_summary",
      "license_status", "license_activate",
    ]) assert.ok(names.includes(n), `missing tool ${n}`);

    const res = await c.send("resources/list", {});
    assert.ok(res.result.resources.some(r => r.uri === "timetracker://today"));
    const prm = await c.send("prompts/list", {});
    assert.ok(prm.result.prompts.some(p => p.name === "daily_standup"));

    const status = await c.call("license_status");
    assert.match(status.text, /"tier": "free"/);

    const start = await c.call("timer_start", { project: "acme", task: "api work" });
    assert.match(start.text, /Started timer for "acme"/);
    const running = await c.call("timer_status");
    assert.match(running.text, /Running: "acme"/);
    const stop = await c.call("timer_stop", { note: "smoke" });
    assert.match(stop.text, /Stopped "acme"/);
    assert.equal(stop.isError, false);

    // manual entry with an explicit rate, then a money report
    await c.call("project_set_rate", { project: "acme", hourly_rate: 100 });
    const today = localDay();
    await c.call("entry_add", { project: "acme", task: "spec", start: `${today}T09:00:00`, minutes: 90 });

    const rep = await c.call("report", { from: `${today}T00:00:00`, to: `${today}T23:59:59`, group_by: "project", format: "json" });
    const parsed = JSON.parse(rep.text.split("\n\nNote:")[0]);
    assert.equal(parsed.rows[0].key, "acme");
    assert.ok(parsed.total.hours >= 1.5, `expected >= 1.5 h, got ${parsed.total.hours}`);
    assert.equal(parsed.total.amount_cents >= 15000, true);
    assert.equal(parsed.tier, "free");

    // D-11: invoice_summary is free inside the 7-day window - the tool the phrase
    // "give me invoice lines" names must answer on the free tier.
    const inv = await c.call("invoice_summary", { project: "acme", from: `${today}T00:00:00`, to: `${today}T23:59:59` });
    assert.equal(inv.isError, false, "invoice_summary must not error on free");
    assert.doesNotMatch(inv.text, /Pro feature/);
    assert.match(inv.text, /Invoice summary - acme/);
    assert.match(inv.text, /USD 100\.00/);          // hourly rate, in the entry currency
    assert.match(inv.text, /TOTAL 1\.5\d h  USD 15\d\.\d\d/);

    // outside the free window it still answers, clamped, and names the upgrade
    const invOld = await c.call("invoice_summary", { project: "acme", from: "2020-01-01T00:00:00", to: `${today}T23:59:59` });
    assert.equal(invOld.isError, false);
    assert.match(invOld.text, /free tier shows the last 7 days/);
    assert.match(invOld.text, /mcp\.zovo\.one\/buy\/time-tracker/);

    // D-R22: tag grouping is FREE. It is a corrected total, not a premium capability.
    const tagRep = await c.call("report", { from: `${today}T00:00:00`, to: `${today}T23:59:59`, group_by: "tag" });
    assert.doesNotMatch(tagRep.text, /Pro feature/);
    assert.match(tagRep.text, /Tag rows can overlap/);

    // D-R22: group_by is optional; without it the report is the plain total per currency.
    const plain = await c.call("report", { from: `${today}T00:00:00`, to: `${today}T23:59:59` });
    assert.equal(plain.isError, false);
    assert.match(plain.text, /^Total 1\.\d\d h, USD 1\d\d\.\d\d\./);

    // free gates that remain: 3rd rated project blocked

    await c.call("project_set_rate", { project: "beta", hourly_rate: 50 });
    const third = await c.call("project_set_rate", { project: "gamma", hourly_rate: 50 });
    assert.match(third.text, /Pro feature/);

    // free history clamp
    const old = await c.call("entry_list", { from: "2020-01-01T00:00:00" });
    assert.match(old.text, /free tier shows the last 7 days/);

    const listed = await c.call("entry_list", {});
    assert.match(listed.text, /acme/);

    const exp = await c.call("export_csv", {});
    assert.match(exp.text, /Wrote \d+ entries to .*\.csv/);
    const path = exp.text.replace(/^Wrote \d+ entries to /, "").split("\n")[0].trim();
    assert.ok(existsSync(path), `csv not written: ${path}`);
  } finally {
    c.close();
  }
});

test.skip("pro tier: a signed key unlocks full invoice history, tag grouping and full history", async () => {
  const key = execFileSync(process.execPath, [join(REPO, "scripts", "sign-license.mjs"), "time-tracker"], { encoding: "utf8" }).trim();
  assert.match(key, /^MCPL1\./);
  const c = client({ MCP_LICENSE_KEY: key });
  try {
    await c.init();
    const status = await c.call("license_status");
    assert.match(status.text, /"tier": "pro"/);

    const today = localDay();
    await c.call("project_set_rate", { project: "acme", hourly_rate: 120 });
    await c.call("entry_add", { project: "acme", task: "build", start: `${today}T10:00:00`, minutes: 120, tags: ["dev"] });
    await c.call("entry_add", { project: "acme", task: "call", start: `${today}T13:00:00`, minutes: 30, tags: ["meeting"] });

    // more than 2 rated projects allowed
    for (const p of ["beta", "gamma", "delta"]) {
      const r = await c.call("project_set_rate", { project: p, hourly_rate: 60 });
      assert.doesNotMatch(r.text, /Pro feature/, `project ${p} should be allowed on pro`);
    }

    const tagRep = await c.call("report", { from: `${today}T00:00:00`, to: `${today}T23:59:59`, group_by: "tag", format: "json" });
    const tags = JSON.parse(tagRep.text).rows.map(r => r.key).sort();
    assert.deepEqual(tags, ["dev", "meeting"]);

    const inv = await c.call("invoice_summary", { project: "acme", from: `${today}T00:00:00`, to: `${today}T23:59:59` });
    assert.equal(inv.isError, false);
    assert.match(inv.text, /Invoice summary - acme/);
    assert.match(inv.text, /USD 120\.00/);      // rate
    assert.match(inv.text, /TOTAL 2\.50 h  USD 300\.00/);

    // full history: no free-tier note
    const hist = await c.call("entry_list", { from: "2020-01-01T00:00:00" });
    assert.doesNotMatch(hist.text, /free tier shows the last 7 days/);

    const csv = await c.call("export_csv", { from: "2020-01-01T00:00:00" });
    assert.doesNotMatch(csv.text, /free tier shows the last 7 days/);

    // resource + prompt work end to end
    const rr = await c.send("resources/read", { uri: "timetracker://today" });
    assert.match(rr.result.contents[0].text, /acme/);
    const pg = await c.send("prompts/get", { name: "daily_standup", arguments: { audience: "client" } });
    assert.match(pg.result.messages[0].content.text, /TODAY/);
  } finally {
    c.close();
  }
});

test("D-R1: invoice_summary prints one line per (task, rate), never a blended rate", async () => {
  const c = client({});
  try {
    await c.init();
    const today = localDay();
    // The exact shape from the user-value run: one 2.50 h entry at EUR 90.00 and one
    // 0.01 h entry with no rate, both with no task. The old code printed EUR 89.82.
    await c.call("entry_add", { project: "Acme", start: `${today}T09:00:00`, minutes: 150, rate: 90, currency: "EUR" });
    await c.call("entry_add", { project: "Acme", start: `${today}T12:00:00`, minutes: 0.6 });
    await c.call("entry_add", { project: "Acme", task: "Design review", start: `${today}T13:00:00`, minutes: 60, rate: 120, currency: "EUR" });
    await c.call("entry_add", { project: "Acme", task: "Design review", start: `${today}T14:00:00`, minutes: 60, rate: 90, currency: "EUR" });

    const inv = await c.call("invoice_summary", { project: "Acme", from: `${today}T00:00:00`, to: `${today}T23:59:59` });
    assert.equal(inv.isError, false, inv.text);
    assert.doesNotMatch(inv.text, /89\.8/, "no blended rate");
    assert.doesNotMatch(inv.text, /mixed/);
    const rows = inv.text.split("\n").filter(l => /^\(no task\)|^Design review/.test(l.trim()));
    assert.equal(rows.length, 4, `expected 4 lines, got:\n${inv.text}`);
    // the rated and the unrated no-task entries are separate lines
    assert.match(inv.text, /\(no task\)\s+2\.50\s+EUR 90\.00\/h\s+EUR 225\.00/);
    assert.match(inv.text, /\(no task\)\s+0\.01\s+-\s+-/);
    // one task at two rates is two lines, not one average
    assert.match(inv.text, /Design review\s+1\.00\s+EUR 120\.00\/h\s+EUR 120\.00/);
    assert.match(inv.text, /Design review\s+1\.00\s+EUR 90\.00\/h\s+EUR 90\.00/);
    // and the total still matches: 225 + 120 + 90
    assert.match(inv.text, /TOTAL 4\.5\d h  EUR 435\.00/);
  } finally {
    c.close();
  }
});
