// Round-13 fix (docs/USER_VALUE_R13.md): D-R66 - a response told the caller to call
// "entry_update {rate, currency}", a tool this server does not have (it is entry_edit).
// A model relays that name, the caller pastes it, and nothing exists on the other end.
// The scan below is the general form: every "<tool> {" citation inside a response string
// has to be a tool this server actually registers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ALLOWED = new Set(["business_set"]); // cross-server calls, checked by servers/invoice

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

function sources() {
  return readdirSync(SRC).filter((f) => f.endsWith(".ts")).map((f) => readFileSync(join(SRC, f), "utf8"));
}

test("every tool name a response cites is a tool this server registers", () => {
  const all = sources().join("\n");
  const registered = new Set([...all.matchAll(/registerTool\(\s*"([a-z0-9_]+)"/g)].map((m) => m[1]));
  assert.ok(registered.size > 0, "no registered tools found - the scan would pass vacuously");

  // A citation is the shape these servers use to name a follow-up call: `name {` inside a
  // string. Schema keys (`name:`) and identifiers are not matched.
  const cited = new Map();
  for (const m of all.matchAll(/(["`'])((?:[^"`'\\]|\\.)*?)\1/g)) {
    for (const c of m[2].matchAll(/\b([a-z][a-z0-9]*(?:_[a-z0-9]+)+)\s*\{/g)) {
      if (!cited.has(c[1])) cited.set(c[1], m[2].slice(0, 120));
    }
  }
  assert.ok(cited.size > 0, "no tool citations found - the scan would pass vacuously");

  const unknown = [...cited].filter(([n]) => !registered.has(n) && !ALLOWED.has(n));
  assert.deepEqual(unknown.map(([n, ctx]) => `${n} -> ${ctx}`), [], "cited but not registered");
});

// D-R67: the day column has been in the shared profile's home zone since D-R35; the clock
// beside it was still the host process zone, so on a UTC host a 09:00 Warsaw entry printed
// as "2026-09-03  07:00" - two zones in one row.
test("entry_list prints the clock in the same zone as the day", async () => {
  const { hhmm, dayKey, resetZoneCache } = await import("../dist/day.js");
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const box = mkdtempSync(join(tmpdir(), "mcp-tt-r13-"));
  const prev = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = join(box, "data");
  mkdirSync(join(box, "data", "mcp-servers", "profile"), { recursive: true });
  writeFileSync(join(box, "data", "mcp-servers", "profile", "business.json"), JSON.stringify({ timezone: "Europe/Warsaw" }));
  resetZoneCache();
  try {
    // 09:00 Warsaw on 2026-09-03 is 07:00Z. The row must read the Warsaw wall clock.
    const iso = "2026-09-03T07:00:00.000Z";
    assert.equal(dayKey(iso), "2026-09-03");
    assert.equal(hhmm(iso), "09:00");
    // Just after midnight Warsaw is still the previous UTC day: both halves must agree.
    const night = "2026-09-03T22:30:00.000Z";
    assert.equal(dayKey(night), "2026-09-04");
    assert.equal(hhmm(night), "00:30");
  } finally {
    if (prev === undefined) delete process.env.XDG_DATA_HOME; else process.env.XDG_DATA_HOME = prev;
    resetZoneCache();
    rmSync(box, { recursive: true, force: true });
  }
});
