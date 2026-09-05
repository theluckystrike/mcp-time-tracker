#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname, isAbsolute, resolve as pathResolve } from "node:path";
import { randomBytes } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createLicenseGate, readSharedProfile, withFileLock } from "@theluckystrike/mcp-license";
import { dayKey, hhmm, homeZone, localDayStart, wallClockInZone } from "./day.js";
import { readJsonFile } from "./jsonstore.js";
import { VERSION } from "./version.js";

const PRODUCT = "time-tracker";
const FREE_WINDOW_DAYS = 7;
const FREE_RATED_PROJECTS = 2;

const gate = createLicenseGate({ product: PRODUCT });

/* ---------------------------------------------------------------- storage */

interface Running {
  id: string;
  project: string;
  task?: string;
  tags: string[];
  rateCents?: number;
  currency?: string;
  start: string;
}
interface Entry {
  id: string;
  project: string;
  task?: string;
  tags: string[];
  start: string;
  end: string;
  seconds: number;
  note?: string;
  billable: boolean;
  rateCents?: number;
  currency?: string;
  /**
   * D-R28: an entry that has been put on an invoice carries the stamp, exactly the way
   * expense-tracker stamps a rebilled receipt. Absent = never billed.
   */
  billed_at?: string;
  billed_invoice?: string;
}
interface ProjectMeta { rateCents: number; currency: string }
interface DB {
  version: 1;
  running: Running | null;
  entries: Entry[];
  projects: Record<string, ProjectMeta>;
}

function dataDir(): string {
  const base = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  return join(base, "mcp-servers", PRODUCT);
}
function dbPath(): string { return join(dataDir(), "data.json"); }

/**
 * Advisory lock held across the whole load-mutate-save cycle. Without it two
 * processes sharing one data dir silently discard each other's writes
 * (see docs/AUDIT.md). Reads (list/report/status/export) stay unlocked.
 */
const LOCK = join(dataDir(), ".lock");

const EMPTY: DB = { version: 1, running: null, entries: [], projects: {} };

/**
 * Codex v3 #1 (P0): only a missing file is an empty database. A corrupt or unreadable
 * file throws, so no mutation can overwrite history that is still on disk.
 */
function load(): DB {
  const raw = readJsonFile<Partial<DB>>(dbPath(), { ...EMPTY });
  return {
    version: 1,
    running: raw.running ?? null,
    entries: Array.isArray(raw.entries) ? raw.entries : [],
    projects: raw.projects && typeof raw.projects === "object" ? raw.projects : {},
  };
}

function save(db: DB): void {
  const dir = dataDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const p = dbPath();
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(db, null, 2));
  renameSync(tmp, p);
}

/* ------------------------------------------------------------- primitives */

function newId(): string { return randomBytes(4).toString("hex"); }

function iso(d: Date): string { return d.toISOString(); }

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Codex v3 #24: a timestamp without an offset ("2026-09-02T09:00:00") is the user's
 * LOCAL time - that is how Date parses it, DST folds included - and a bare date is
 * local midnight, not UTC midnight (#20). An explicit offset or trailing Z is honoured.
 */
function parseTime(s: string, what: string): Date {
  const t = String(s).trim();
  // D-R35: with a home zone on the shared business profile, a stamp that names no offset
  // is wall-clock time THERE, not on whatever machine the server happens to run on.
  const inZone = wallClockInZone(t);
  if (inZone) {
    if (Number.isNaN(inZone.getTime())) throw new Error(`${what} is not a valid date/time: ${s}`);
    return inZone;
  }
  if (DATE_ONLY.test(t)) {
    const [y, m, d] = t.split("-").map(Number);
    const local = new Date(y, m - 1, d);
    if (Number.isNaN(local.getTime())) throw new Error(`${what} is not a valid date/time: ${s}`);
    return local;
  }
  const d2 = new Date(t);
  if (Number.isNaN(d2.getTime())) throw new Error(`${what} is not a valid date/time: ${s}`);
  return d2;
}

/** Codex v3 #20: a date-only upper bound means the END of that local day, inclusive. */
function endOfLocalDay(s: string): number {
  const zoned = wallClockInZone(s);
  if (zoned) {
    const next = wallClockInZone(dayKeyPlusOne(s));
    if (next) return next.getTime() - 1;
  }
  const [y, m, d] = String(s).trim().split("-").map(Number);
  return new Date(y, m - 1, d + 1).getTime() - 1;
}

/** The calendar day after a YYYY-MM-DD string, as a YYYY-MM-DD string. */
function dayKeyPlusOne(s: string): string {
  const [y, m, d] = String(s).trim().slice(0, 10).split("-").map(Number);
  const n = new Date(Date.UTC(y, m - 1, d + 1));
  return n.toISOString().slice(0, 10);
}



function toCents(v: number): number { return Math.round(v * 100); }

/* ------------------------------------------------------------- currency */

const CURRENCY_WORDS: Record<string, string> = {
  usd: "USD", dollar: "USD", dollars: "USD", "$": "USD", buck: "USD", bucks: "USD",
  eur: "EUR", euro: "EUR", euros: "EUR", "\u20ac": "EUR",
  gbp: "GBP", pound: "GBP", pounds: "GBP", sterling: "GBP", "\u00a3": "GBP",
  pln: "PLN", zl: "PLN", "z\u0142": "PLN", zloty: "PLN", zlotys: "PLN", zloties: "PLN",
  chf: "CHF", cad: "CAD", aud: "AUD", sek: "SEK", nok: "NOK", dkk: "DKK", czk: "CZK",
  jpy: "JPY", yen: "JPY", inr: "INR", rupee: "INR", rupees: "INR",
};

/** "euros" -> EUR, "90 EUR" -> EUR, "eur" -> EUR. Unknown 3-letter codes pass through uppercased. */
function normCurrency(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const s = String(raw).trim().toLowerCase();
  if (!s) return undefined;
  if (CURRENCY_WORDS[s]) return CURRENCY_WORDS[s];
  for (const w of s.split(/[^a-z\u20ac\u00a3$\u0142]+/).filter(Boolean)) {
    if (CURRENCY_WORDS[w]) return CURRENCY_WORDS[w];
  }
  const code = s.replace(/[^a-z]/g, "");
  if (code.length === 3) return code.toUpperCase();
  return undefined;
}

/**
 * The model may pass rate as a number (90) or as the words the user said ("90 euros an hour").
 * Returns the numeric rate plus any currency found in the text.
 */
function parseRate(rate: number | string | undefined): { rate?: number; currency?: string } {
  if (rate === undefined || rate === null) return {};
  if (typeof rate === "number") {
    if (!Number.isFinite(rate) || rate < 0) throw new Error(`rate must be a non-negative number: ${rate}`);
    return { rate };
  }
  const txt = String(rate).trim();
  const n = parseAmount(txt);
  if (!Number.isFinite(n) || n < 0) throw new Error(`rate must be a non-negative number, got ${JSON.stringify(txt)}`);
  return { rate: n, currency: normCurrency(txt.replace(/[\d.,]+/g, " ")) };
}
/**
 * Codex v3 #18. "1,200 USD" is 1200 (thousands grouping: a comma followed by exactly
 * three digits), "1.200,50" is 1200.50, "12,50 EUR" is 12.50 (the unambiguous European
 * decimal shape, one or two digits after the comma). Anything else with a separator
 * that could mean either thing is refused with an example instead of guessed.
 */
function parseAmount(raw: string): number {
  const t = String(raw).replace(/[^\d.,]/g, "");
  if (!t) throw new Error(`rate must contain a number, got ${JSON.stringify(raw)}`);
  if (/^\d+(\.\d+)?$/.test(t)) return Number(t);                                  // 90 / 90.50 / 1.2
  if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(t)) return Number(t.replace(/,/g, ""));   // 1,200 / 1,200.50
  if (/^\d{1,3}(\.\d{3})+(,\d{1,2})?$/.test(t)) return Number(t.replace(/\./g, "").replace(",", "."));  // 1.200,50
  if (/^\d+,\d{1,2}$/.test(t)) return Number(t.replace(",", "."));                // 12,50
  throw new Error(
    `rate ${JSON.stringify(String(raw))} is ambiguous: write 1200 or "1,200.00" for one thousand two hundred, ` +
    `or 12.50 or "12,50" for twelve and a half.`,
  );
}

function money(cents: number, currency: string): string {
  const sign = cents < 0 ? "-" : "";
  const a = Math.abs(cents);
  return `${sign}${currency} ${Math.floor(a / 100)}.${String(a % 100).padStart(2, "0")}`;
}
function hours(seconds: number): string { return (seconds / 3600).toFixed(2); }
function hms(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(Math.floor(s / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}`;
}

function amountCents(seconds: number, rateCents: number): number {
  return Math.round((seconds * rateCents) / 3600);
}

/**
 * Codex v3 #19: the rate is captured on the entry when it is logged, so changing a
 * project rate later never rewrites history. The project lookup below is a fallback
 * for entries written by older versions, which carry no rate of their own.
 */
function rateForEntry(db: DB, e: Entry): number {
  if (typeof e.rateCents === "number") return e.rateCents;
  return db.projects[e.project]?.rateCents ?? 0;
}
function currencyFor(db: DB, project: string): string {
  return db.projects[project]?.currency ?? readSharedProfile().default_currency ?? "USD";
}
/** D-3: the currency stored on the entry wins over the project default. */
function currencyForEntry(db: DB, e: Entry): string {
  return e.currency ?? currencyFor(db, e.project);
}

/** Sum of money split by currency, so mixed-currency periods are never added together. */
type Amounts = Map<string, number>;
function addAmount(m: Amounts, currency: string, cents: number): void {
  if (cents === 0 && !m.has(currency)) return;
  m.set(currency, (m.get(currency) ?? 0) + cents);
}
function mergeAmounts(into: Amounts, from: Amounts): void {
  for (const [c, v] of from) addAmount(into, c, v);
}
function nonZero(m: Amounts): [string, number][] {
  return [...m.entries()].filter(([, c]) => c !== 0).sort((a, b) => b[1] - a[1]);
}
/** "EUR 225.00", or "EUR 225.00 + USD 90.00" when a bucket mixes currencies. */
function moneyOf(m: Amounts): string {
  const parts = nonZero(m);
  return parts.length ? parts.map(([c, v]) => money(v, c)).join(" + ") : "-";
}

/* ------------------------------------------------------- project matching */

function knownProjects(db: DB): string[] {
  const s = new Set<string>(Object.keys(db.projects));
  for (const e of db.entries) s.add(e.project);
  if (db.running) s.add(db.running.project);
  return [...s];
}

type Resolved =
  | { kind: "use"; project: string; note?: string }
  | { kind: "ambiguous"; candidates: string[] };

/**
 * D-7: "Acme" should land on the existing "Acme website" project instead of silently
 * creating a second one. Exact (case-insensitive) match wins; otherwise a prefix or
 * containment match is used only when exactly one existing project matches.
 */
function resolveProject(db: DB, input: string): Resolved {
  const given = String(input).trim();
  const q = given.toLowerCase();
  const known = knownProjects(db);
  const exact = known.find(p => p.toLowerCase() === q);
  if (exact) return { kind: "use", project: exact, note: exact === given ? undefined : `Matched the existing project "${exact}".` };
  if (!q) return { kind: "use", project: given };
  const near = known.filter(p => {
    const k = p.toLowerCase();
    return k.startsWith(q) || q.startsWith(k) || k.includes(q) || q.includes(k);
  });
  if (near.length === 1) return { kind: "use", project: near[0], note: `Used the existing project "${near[0]}" (you said "${given}").` };
  if (near.length > 1) return { kind: "ambiguous", candidates: near.sort() };
  return { kind: "use", project: given };
}

function ambiguousText(given: string, candidates: string[]): string {
  return `"${given}" matches ${candidates.length} existing projects: ${candidates.map(c => `"${c}"`).join(", ")}. ` +
    `Nothing was written or reported. Repeat the request with the exact project name you mean.`;
}

function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map(r => (r[i] ?? "").length)));
  const line = (cells: string[]) => cells.map((c, i) => (c ?? "").padEnd(widths[i])).join("  ").trimEnd();
  return [line(headers), line(widths.map(w => "-".repeat(w))), ...rows.map(line)].join("\n");
}

function csvCell(v: string): string {
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

const ok = (text: string) => ({ content: [{ type: "text" as const, text }] });
const err = (text: string) => ({ content: [{ type: "text" as const, text: `Error: ${text}` }], isError: true });
/** Gated feature: not an error, the user must see the upgrade path. */
const gated = (feature: string, toolName?: string) => ok(gate.upgradeText(feature, toolName));

function guard<A>(fn: (a: A) => Promise<{ content: { type: "text"; text: string }[]; isError?: boolean }>) {
  return async (a: A) => {
    try { return await fn(a); }
    catch (e) { return err(e instanceof Error ? e.message : String(e)); }
  };
}

/* ------------------------------------------------------------- selection */

interface Window { fromMs: number; toMs: number; clamped: boolean }

/**
 * Codex v3 #20: `from: "2026-09-01"` is local start of day, `to: "2026-09-30"` is local
 * END of that day (23:59:59.999), so a month reported by dates includes its last day.
 */
function windowFor(from: string | undefined, to: string | undefined, pro: boolean): Window {
  const fromMs = from ? parseTime(from, "from").getTime() : -Infinity;
  const toMs = to ? (DATE_ONLY.test(String(to).trim()) ? endOfLocalDay(to) : parseTime(to, "to").getTime()) : Infinity;
  if (pro) return { fromMs, toMs, clamped: false };
  const floor = localDayStart(FREE_WINDOW_DAYS - 1).getTime();
  return { fromMs: Math.max(fromMs, floor), toMs, clamped: fromMs < floor };
}

/**
 * Codex v3 #21: an entry counts for the part of it that lies inside the window, not
 * all-or-nothing on its start time. Returns null when the overlap is empty.
 */
function clip(e: Entry, w: Window): Entry | null {
  const s = new Date(e.start).getTime();
  const en = new Date(e.end).getTime();
  const a = Math.max(s, w.fromMs);
  const b = Math.min(en, w.toMs);
  if (!(b > a)) return null;
  if (a === s && b === en) return e;
  return { ...e, start: iso(new Date(a)), end: iso(new Date(b)), seconds: Math.round((b - a) / 1000) };
}

function select(db: DB, w: Window, project?: string): Entry[] {
  const out: Entry[] = [];
  for (const e of db.entries) {
    if (project && e.project.toLowerCase() !== project.toLowerCase()) continue;
    const c = clip(e, w);
    if (c) out.push(c);
  }
  return out.sort((a, b) => a.start.localeCompare(b.start));
}

/** D-R28: true once the entry has been stamped onto an invoice by entry_mark_billed. */
function isBilled(e: Entry): boolean {
  return typeof e.billed_at === "string" && e.billed_at.length > 0;
}

/** Drop already-invoiced entries unless the caller explicitly asked for all of them. */
function unbilled(entries: Entry[], unbilledOnly: boolean): Entry[] {
  return unbilledOnly ? entries.filter(e => !isBilled(e)) : entries;
}

const BILLED_NOTE = (n: number) =>
  `\n\n${n} ${n === 1 ? "entry is" : "entries are"} hidden because ${n === 1 ? "it has" : "they have"} already been invoiced. Pass unbilled_only: false to include ${n === 1 ? "it" : "them"}.`;

/** Resolve an optional project filter the same way creation does (Codex v3 #29). */
type Filter = { kind: "ok"; project?: string } | { kind: "ambiguous"; text: string };
function resolveFilter(db: DB, project: string | undefined): Filter {
  if (!project) return { kind: "ok" };
  const r = resolveProject(db, project);
  if (r.kind === "ambiguous") return { kind: "ambiguous", text: ambiguousText(project, r.candidates) };
  return { kind: "ok", project: r.project };
}

const FREE_WINDOW_NOTE =
  `\n\nNote: the free tier shows the last ${FREE_WINDOW_DAYS} days. ` + gate.upgradeText("full history");

/* ---------------------------------------------------------------- server */

const server = new McpServer(
  { name: "mcp-time-tracker", version: VERSION },
  { capabilities: { tools: {}, resources: {}, prompts: {} } },
);

gate.registerTools(server as unknown as { registerTool: Function });

function stopRunning(db: DB, endDate: Date, note?: string): Entry {
  const r = db.running!;
  const start = new Date(r.start);
  const seconds = Math.max(0, Math.round((endDate.getTime() - start.getTime()) / 1000));
  // Codex v3 #19: capture the effective rate and currency now, at stop time.
  const meta = db.projects[r.project];
  // D-R35: a timer started with no rate and no project rate has no money on it. Stamping
  // rateCents 0 / currency USD invented a US-dollar row inside a EUR business, and that
  // zero row then rode into invoice_summary, entry_mark_billed and the CSV. Leave both
  // fields unset instead; every reader already treats "no rate" as "no amount".
  const knownRate = typeof r.rateCents === "number" ? r.rateCents : meta?.rateCents;
  const knownCurrency = r.currency ?? meta?.currency;
  const entry: Entry = {
    id: newId(), project: r.project, task: r.task, tags: r.tags,
    start: iso(start), end: iso(endDate), seconds, note, billable: true,
    ...(typeof knownRate === "number" ? { rateCents: knownRate } : {}),
    ...(knownCurrency ? { currency: knownCurrency } : {}),
  };
  db.entries.push(entry);
  db.running = null;
  return entry;
}

server.registerTool("timer_start", {
  title: "Start timer",
  description: "Start a stopwatch for billable work on a project or client (timesheet / hours per project). Only one timer runs at a time: starting a new one stops and logs the previous one.",
  inputSchema: {
    project: z.string().min(1).describe("Project or client name, e.g. 'acme-website'. A partial name that matches exactly one existing project is used as that project."),
    task: z.string().optional().describe("What you are working on right now"),
    tags: z.array(z.string()).optional().describe("Free-form tags, e.g. ['dev','meeting']"),
    rate: z.union([z.number().nonnegative(), z.string()]).optional().describe("Hourly rate for this timer only; a number (90) or the words the user said, e.g. rate '90 euros an hour'. Defaults to the project rate set by project_set_rate."),
    currency: z.string().optional().describe("Currency of the rate: EUR, USD, GBP, PLN, or words like 'euros'. Defaults to the project currency, else USD."),
  },
}, guard(async ({ project, task, tags, rate, currency }: { project: string; task?: string; tags?: string[]; rate?: number | string; currency?: string }) => {
  return withFileLock(LOCK, async () => {
  const db = load();
  const r = resolveProject(db, project);
  if (r.kind === "ambiguous") return ok(ambiguousText(project, r.candidates));
  const parsed = parseRate(rate);
  const cur = normCurrency(currency) ?? parsed.currency;
  const now = new Date();
  let stopped: Entry | null = null;
  if (db.running) stopped = stopRunning(db, now, "auto-stopped by timer_start");
  db.running = {
    id: newId(), project: r.project, task, tags: tags ?? [],
    ...(typeof parsed.rate === "number" ? { rateCents: toCents(parsed.rate) } : {}),
    ...(cur ? { currency: cur } : {}),
    start: iso(now),
  };
  save(db);
  const lines = [`Started timer for "${r.project}"${task ? ` - ${task}` : ""} at ${db.running.start}.`];
  if (typeof parsed.rate === "number") lines.push(`Rate ${money(toCents(parsed.rate), cur ?? currencyFor(db, r.project))} per hour.`);
  if (r.note) lines.unshift(r.note);
  if (stopped) lines.unshift(`Stopped "${stopped.project}" after ${hms(stopped.seconds)} (entry ${stopped.id}).`);
  return ok(lines.join("\n"));
  });
}));

server.registerTool("timer_stop", {
  title: "Stop timer",
  description: "Stop the running timer and log it as a time entry. Returns the duration and the entry id.",
  inputSchema: { note: z.string().optional().describe("Optional note stored with the entry") },
}, guard(async ({ note }: { note?: string }) => {
  return withFileLock(LOCK, async () => {
  const db = load();
  if (!db.running) return ok("No timer is running. Start one with timer_start.");
  const e = stopRunning(db, new Date(), note);
  save(db);
  const rc = rateForEntry(db, e);
  const cur = currencyForEntry(db, e);
  const amount = rc > 0
    ? `  ${money(amountCents(e.seconds, rc), cur)}`
    : "  No rate: this entry carries no currency and no amount. Set one with project_set_rate, or entry_edit {id, rate, currency}.";
  return ok(`Stopped "${e.project}"${e.task ? ` - ${e.task}` : ""}. Duration ${hms(e.seconds)} (${hours(e.seconds)} h).${amount}\nEntry id ${e.id}.`);
  });
}));

server.registerTool("timer_status", {
  title: "Timer status",
  description: "Show the running timer, how long it has been running, and today's total hours so far.",
  inputSchema: {},
}, guard(async () => {
  const db = load();
  // Codex v3 #23: today is the intersection with [start of today, start of tomorrow),
  // for logged entries and for the running timer alike - a timer started at 23:30
  // yesterday contributes only the minutes after midnight.
  const todayStart = localDayStart(0).getTime();
  const tomorrowStart = localDayStart(-1).getTime();
  const w: Window = { fromMs: todayStart, toMs: tomorrowStart - 1, clamped: false };
  const todayEntries = select(db, w);
  let todaySec = todayEntries.reduce((a, e) => a + e.seconds, 0);
  const lines: string[] = [];
  if (db.running) {
    const startMs = new Date(db.running.start).getTime();
    const sec = Math.round((Date.now() - startMs) / 1000);
    const todayPart = Math.max(0, Math.round((Math.min(Date.now(), tomorrowStart) - Math.max(startMs, todayStart)) / 1000));
    todaySec += todayPart;
    lines.push(`Running: "${db.running.project}"${db.running.task ? ` - ${db.running.task}` : ""} for ${hms(sec)} (since ${db.running.start}).`);
  } else {
    lines.push("No timer running.");
  }
  lines.push(`Today: ${hms(todaySec)} (${hours(todaySec)} h) across ${todayEntries.length} logged entries.`);
  return ok(lines.join("\n"));
}));

server.registerTool("entry_add", {
  title: "Add time entry",
  description: "Log billable (or non-billable) time you already worked on a project - a timesheet entry. Give start plus either end or minutes, and optionally the hourly rate and its currency, e.g. rate '90 euros an hour' -> EUR.",
  inputSchema: {
    project: z.string().min(1).describe("Project or client name. A partial name that matches exactly one existing project is used as that project."),
    task: z.string().optional().describe("What the work was"),
    start: z.string().describe("ISO 8601 start time, e.g. 2026-09-02T09:00:00"),
    end: z.string().optional().describe("ISO 8601 end time (or use minutes)"),
    minutes: z.number().positive().optional().describe("Duration in minutes (alternative to end)"),
    note: z.string().optional().describe("Optional note"),
    tags: z.array(z.string()).optional().describe("Optional tags"),
    billable: z.boolean().optional().describe("Default true; set false for non-billable work"),
    rate: z.union([z.number().nonnegative(), z.string()]).optional().describe("Hourly rate for this entry; a number (90) or the words the user said ('90 euros an hour')"),
    currency: z.string().optional().describe("Currency of the rate: EUR, USD, GBP, PLN, or words like 'euros'. Defaults to the project currency, else USD."),
  },
}, guard(async (a: { project: string; task?: string; start: string; end?: string; minutes?: number; note?: string; tags?: string[]; billable?: boolean; rate?: number | string; currency?: string }) => {
  return withFileLock(LOCK, async () => {
  const start = parseTime(a.start, "start");
  let end: Date;
  if (a.end) end = parseTime(a.end, "end");
  else if (typeof a.minutes === "number") end = new Date(start.getTime() + a.minutes * 60000);
  else throw new Error("give either end or minutes");
  const seconds = Math.round((end.getTime() - start.getTime()) / 1000);
  if (seconds <= 0) throw new Error("end must be after start");
  const db = load();
  const r = resolveProject(db, a.project);
  if (r.kind === "ambiguous") return ok(ambiguousText(a.project, r.candidates));
  const parsed = parseRate(a.rate);
  const cur = normCurrency(a.currency) ?? parsed.currency;
  // Codex v3 #19: the entry keeps the rate that was in force when it was logged.
  const meta = db.projects[r.project];
  const e: Entry = {
    id: newId(), project: r.project, task: a.task, tags: a.tags ?? [],
    start: iso(start), end: iso(end), seconds, note: a.note,
    billable: a.billable !== false,
    rateCents: typeof parsed.rate === "number" ? toCents(parsed.rate) : (meta?.rateCents ?? 0),
    currency: cur ?? meta?.currency ?? "USD",
  };
  db.entries.push(e);
  save(db);
  const rc = rateForEntry(db, e);
  const ecur = currencyForEntry(db, e);
  const amount = rc > 0 && e.billable ? ` ${money(rc, ecur)}/h, ${money(amountCents(e.seconds, rc), ecur)}.` : "";
  const lines = [`Added entry ${e.id}: "${e.project}"${e.task ? ` - ${e.task}` : ""}, ${hms(seconds)} (${hours(seconds)} h), ${e.billable ? "billable" : "non-billable"}.${amount}`];
  if (r.note) lines.unshift(r.note);
  return ok(lines.join("\n"));
  });
}));

server.registerTool("entry_list", {
  title: "List time entries",
  description: "List logged time entries (timesheet rows) as a compact table, with hours, billable flag and project. Free tier shows the last 7 days.",
  inputSchema: {
    from: z.string().optional().describe("ISO date/time lower bound"),
    to: z.string().optional().describe("ISO date/time upper bound"),
    project: z.string().optional().describe("Filter by project name"),
    limit: z.number().int().positive().optional().describe("Maximum rows, newest first (default 50)"),
  },
}, guard(async (a: { from?: string; to?: string; project?: string; limit?: number }) => {
  const db = load();
  const f = resolveFilter(db, a.project);          // Codex v3 #29
  if (f.kind === "ambiguous") return ok(f.text);
  const pro = gate.isPro();
  const w = windowFor(a.from, a.to, pro);
  const all = select(db, w, f.project);
  const limit = a.limit ?? 50;
  const rows = all.slice(-limit).reverse();
  if (rows.length === 0) {
    // D-R85: an empty store reads to a model as "nothing exists here yet, ask before writing".
    // entry_add already creates the named project on the fly (see resolveProject), so a plain
    // "no entries found" bought a confirmation question for facts the caller had already given.
    const msg = db.entries.length === 0
      ? "No time entries logged yet. entry_add creates the project from its project argument automatically - no setup needed."
      : "No entries found for that filter.";
    return ok(`${msg}${!pro && w.clamped ? FREE_WINDOW_NOTE : ""}`);
  }
  const totalSec = rows.reduce((s, e) => s + e.seconds, 0);
  const body = table(
    ["id", "day", "start", "project", "task", "hours", "bill", "tags", "note"],
    rows.map(e => [
      e.id, dayKey(e.start), hhmm(e.start),
      e.project, e.task ?? "", hours(e.seconds), e.billable ? "y" : "n",
      e.tags.join(","), e.note ?? "",
    ]),
  );
  const tail = `\n\n${rows.length} entries, ${hours(totalSec)} h total.`;
  return ok(body + tail + (!pro && w.clamped ? FREE_WINDOW_NOTE : ""));
}));

server.registerTool("entry_delete", {
  title: "Delete time entry",
  description: "Delete one time entry by id.",
  inputSchema: { id: z.string().describe("Entry id from entry_list") },
}, guard(async ({ id }: { id: string }) => {
  return withFileLock(LOCK, async () => {
  const db = load();
  const i = db.entries.findIndex(e => e.id === id);
  if (i < 0) return err(`no entry with id ${id}`);
  const [e] = db.entries.splice(i, 1);
  save(db);
  return ok(`Deleted entry ${id} ("${e.project}", ${hours(e.seconds)} h).`);
  });
}));

server.registerTool("entry_edit", {
  title: "Edit time entry",
  description: "Change fields of an existing entry. Only the fields you pass are changed.",
  inputSchema: {
    id: z.string().describe("Entry id from entry_list"),
    project: z.string().optional(),
    task: z.string().optional(),
    start: z.string().optional().describe("ISO 8601"),
    end: z.string().optional().describe("ISO 8601"),
    minutes: z.number().positive().optional().describe("New duration in minutes, keeps start"),
    note: z.string().optional(),
    tags: z.array(z.string()).optional(),
    billable: z.boolean().optional(),
    rate: z.union([z.number().nonnegative(), z.string()]).optional().describe("Hourly rate override for this entry, a number or words like '90 euros'"),
    currency: z.string().optional().describe("Currency of the rate, e.g. EUR"),
  },
}, guard(async (a: { id: string; project?: string; task?: string; start?: string; end?: string; minutes?: number; note?: string; tags?: string[]; billable?: boolean; rate?: number | string; currency?: string }) => {
  return withFileLock(LOCK, async () => {
  const db = load();
  const e = db.entries.find(x => x.id === a.id);
  if (!e) return err(`no entry with id ${a.id}`);
  if (a.project !== undefined) e.project = a.project;
  if (a.task !== undefined) e.task = a.task;
  if (a.note !== undefined) e.note = a.note;
  if (a.tags !== undefined) e.tags = a.tags;
  if (a.billable !== undefined) e.billable = a.billable;
  if (a.rate !== undefined) {
    const parsed = parseRate(a.rate);
    if (typeof parsed.rate === "number") e.rateCents = toCents(parsed.rate);
    if (parsed.currency) e.currency = parsed.currency;
  }
  if (a.currency !== undefined) {
    const c = normCurrency(a.currency);
    if (c) e.currency = c;
  }
  if (a.start !== undefined) e.start = iso(parseTime(a.start, "start"));
  if (a.end !== undefined) e.end = iso(parseTime(a.end, "end"));
  if (a.minutes !== undefined) e.end = iso(new Date(new Date(e.start).getTime() + a.minutes * 60000));
  const seconds = Math.round((new Date(e.end).getTime() - new Date(e.start).getTime()) / 1000);
  if (seconds <= 0) return err("end must be after start");
  e.seconds = seconds;
  save(db);
  return ok(`Updated entry ${e.id}: "${e.project}"${e.task ? ` - ${e.task}` : ""}, ${hours(e.seconds)} h, ${e.billable ? "billable" : "non-billable"}.`);
  });
}));

server.registerTool("project_set_rate", {
  title: "Set project rate",
  description: "Set the hourly rate and currency used to turn tracked hours into money for a project or client. Returns the new rate and, when re-rating is asked for, how many already logged entries changed.",
  inputSchema: {
    project: z.string().min(1).describe("Project or client name. A partial name that matches exactly one existing project is used as that project."),
    hourly_rate: z.union([z.number().nonnegative(), z.string()]).describe("Hourly rate: a number (85) or the words the user said ('90 euros an hour'). '1,200 USD' is 1200; '12,50 EUR' is 12.50; anything ambiguous is refused."),
    currency: z.string().optional().describe("Currency: a code (EUR, USD, GBP, PLN) or a word ('euros', 'pounds', 'zl'). Defaults to the shared business profile's default_currency, else USD."),
    apply_to_existing: z.boolean().optional().describe("Re-rate time already logged for this project: every entry is re-stamped with the new rate, including entries that already carry one. Default false: the new rate applies to future entries only, because each entry captures the rate in force when it was logged."),
    only_missing: z.boolean().optional().describe("Only meaningful with apply_to_existing. True restores the old fill-the-gaps behaviour: only entries that carry no rate of their own are touched. Default false, which re-stamps every entry of the project."),
  },
}, guard(async (a: { project: string; hourly_rate: number | string; currency?: string; apply_to_existing?: boolean; only_missing?: boolean }) => {
  return withFileLock(LOCK, async () => {
  const db = load();
  const r = resolveProject(db, a.project);         // Codex v3 #29
  if (r.kind === "ambiguous") return ok(ambiguousText(a.project, r.candidates));
  const project = r.project;
  const isNew = !(project in db.projects);
  if (isNew && !gate.isPro() && Object.keys(db.projects).length >= FREE_RATED_PROJECTS) {
    return gated(`more than ${FREE_RATED_PROJECTS} projects with rates`, "project_set_rate");
  }
  const parsed = parseRate(a.hourly_rate);
  if (typeof parsed.rate !== "number") throw new Error("hourly_rate must contain a number");
  // Profile-first sweep: the currency you bill in is business identity, held once behind
  // the token. This tool defaulted to USD while currencyFor() one screen up already reads
  // the shared profile, so a PLN business setting a rate got a USD project. An explicit
  // currency, and a currency spelled out in hourly_rate, both still win.
  const shared = readSharedProfile().default_currency;
  const profileCurrency = shared && /^[A-Za-z]{3}$/.test(shared.trim()) ? shared.trim().toUpperCase() : undefined;
  const chosen = normCurrency(a.currency) ?? parsed.currency ?? profileCurrency ?? "USD";
  const currencyFromProfile = !normCurrency(a.currency) && !parsed.currency && !!profileCurrency;
  db.projects[project] = {
    rateCents: toCents(parsed.rate),
    currency: chosen,
  };
  const m = db.projects[project];
  // Codex v3 #19 kept the rate captured at log time on every entry, which made the old
  // "backfill entries with no rate" loop dead code (D-R18): every entry written by this
  // server already has one, so "apply the new rate to existing entries" changed nothing.
  // apply_to_existing now RE-STAMPS every entry of the project. only_missing restores the
  // old fill-the-gaps behaviour for callers that want it.
  const onlyMissing = a.only_missing === true;
  let changed = 0;
  const projectEntries = db.entries.filter((e) => e.project === project);
  if (a.apply_to_existing) {
    for (const e of projectEntries) {
      if (onlyMissing && typeof e.rateCents === "number") continue;
      if (e.rateCents === m.rateCents && e.currency === m.currency) continue;
      e.rateCents = m.rateCents;
      e.currency = m.currency;
      changed += 1;
    }
  }
  save(db);
  const lines = [`Rate for "${project}" set to ${money(m.rateCents, m.currency)} per hour.`];
  if (currencyFromProfile) lines.push(`Currency ${m.currency} came from the shared business profile (default_currency); pass currency to override it.`);
  if (a.apply_to_existing) {
    const totals = totalsOf(db, projectEntries);
    const scope = onlyMissing ? "entries that had no rate of their own" : "already logged entries";
    lines.push(
      `${changed} of ${projectEntries.length} ${scope} re-rated (only_missing: ${onlyMissing}). ` +
      `New total for "${project}": ${hours(totals.seconds)} h, ${moneyOf(totals.amounts)}.`,
    );
  } else {
    lines.push("Applies to future entries only: time already logged keeps the rate captured when it was logged (pass apply_to_existing to re-rate it, or apply_to_existing plus only_missing to fill only the gaps).");
  }
  if (r.note) lines.unshift(r.note);
  return ok(lines.join("\n"));
  });
}));

const GROUPS = ["project", "day", "task", "tag"] as const;
type Group = typeof GROUPS[number];

/**
 * Codex v3 #22: an entry that runs past local midnight belongs to both days, split at
 * the boundary, so a night shift is not billed wholly to the day it started on.
 */
function splitByDay(e: Entry): { key: string; seconds: number }[] {
  const end = new Date(e.end).getTime();
  const out: { key: string; seconds: number }[] = [];
  let cur = new Date(e.start).getTime();
  while (cur < end) {
    const midnight = new Date(cur);
    midnight.setHours(24, 0, 0, 0);
    const next = Math.min(midnight.getTime(), end);
    out.push({ key: dayKey(new Date(cur).toISOString()), seconds: Math.round((next - cur) / 1000) });
    cur = next;
  }
  return out.length ? out : [{ key: dayKey(e.start), seconds: e.seconds }];
}

/** The (key, seconds) pairs one entry contributes to a grouping. Tag rows overlap by design. */
function partsOf(e: Entry, by: Group): { key: string; seconds: number }[] {
  if (by === "day") return splitByDay(e);
  if (by === "project") return [{ key: e.project, seconds: e.seconds }];
  if (by === "task") return [{ key: e.task && e.task.trim() ? e.task : "(no task)", seconds: e.seconds }];
  return (e.tags.length ? e.tags : ["(no tag)"]).map(t => ({ key: t, seconds: e.seconds }));
}

interface Bucket { key: string; seconds: number; billableSeconds: number; amounts: Amounts }

function aggregate(db: DB, entries: Entry[], by: Group): Bucket[] {
  const m = new Map<string, Bucket>();
  for (const e of entries) {
    const rc = rateForEntry(db, e);
    const cur = currencyForEntry(db, e);
    for (const part of partsOf(e, by)) {
      const b = m.get(part.key) ?? { key: part.key, seconds: 0, billableSeconds: 0, amounts: new Map<string, number>() as Amounts };
      b.seconds += part.seconds;
      if (e.billable) { b.billableSeconds += part.seconds; addAmount(b.amounts, cur, amountCents(part.seconds, rc)); }
      m.set(part.key, b);
    }
  }
  return [...m.values()].sort((a, b) => b.seconds - a.seconds);
}

/**
 * Codex v3 #26: totals are computed from the entries, once each, never by summing
 * buckets - a two-tag entry sits in two tag rows and would otherwise be billed twice.
 */
interface Totals { seconds: number; billableSeconds: number; amounts: Amounts }
function totalsOf(db: DB, entries: Entry[]): Totals {
  const amounts = new Map<string, number>() as Amounts;
  let seconds = 0, billableSeconds = 0;
  for (const e of entries) {
    seconds += e.seconds;
    if (!e.billable) continue;
    billableSeconds += e.seconds;
    addAmount(amounts, currencyForEntry(db, e), amountCents(e.seconds, rateForEntry(db, e)));
  }
  return { seconds, billableSeconds, amounts };
}

const TAG_OVERLAP_NOTE =
  "Tag rows can overlap: an entry tagged twice appears in both rows. The total counts every entry once.";

server.registerTool("report", {
  title: "Time report",
  description: "Timesheet report: total tracked hours and billable money for a period, optionally grouped by (group by) project, day, task or tag - hours per project, how much to bill. Omit group_by for the plain total per currency.",
  inputSchema: {
    from: z.string().describe("ISO date/time start of the period. On the free tier the window is clamped to the last 7 days; Pro reports over the full history."),
    to: z.string().describe("ISO date/time end of the period. On the free tier the window is clamped to the last 7 days; Pro reports over the full history."),
    group_by: z.enum(GROUPS).optional().describe("project | day | task | tag. Optional: omit it for the plain total per currency, with no breakdown. Money is grouped by currency and EUR is never added to USD."),
    format: z.enum(["table", "json", "csv"]).optional().describe("table (default), json or csv. Every format carries one amount per currency, never a mixed-currency sum."),
    project: z.string().optional().describe("Optional project filter"),
    unbilled_only: z.boolean().optional().describe("Default true: hours already put on an invoice (entry_mark_billed) are excluded, so the report answers 'what is still to bill'. Pass false for the full timesheet including invoiced work."),
  },
}, guard(async (a: { from: string; to: string; group_by?: Group; format?: "table" | "json" | "csv"; project?: string; unbilled_only?: boolean }) => {
  const pro = gate.isPro();
  // D-R22: tag grouping is free. It is a corrected total, not a premium capability, and
  // gating it hid the #26/#27 fix from every free user. Pro keeps full history and
  // unlimited rated projects.
  const db = load();
  const f = resolveFilter(db, a.project);          // Codex v3 #29
  if (f.kind === "ambiguous") return ok(f.text);
  const w = windowFor(a.from, a.to, pro);
  const unbilledOnly = a.unbilled_only !== false;          // D-R28: default true
  const all = select(db, w, f.project);
  const entries = unbilled(all, unbilledOnly);
  const hidden = all.length - entries.length;
  const billedNote = hidden > 0 ? BILLED_NOTE(hidden) : "";
  const buckets = a.group_by ? aggregate(db, entries, a.group_by) : [];
  const totals = totalsOf(db, entries);            // Codex v3 #26
  const totalSec = totals.seconds;
  const totalParts = nonZero(totals.amounts);
  const currency = totalParts.length ? totalParts[0][0] : "USD";
  const fmt = a.format ?? "table";
  const mixed = totalParts.length > 1
    ? "\nAmounts are grouped by currency: EUR is never added to USD, so read one total per currency."
    : "";
  const note = (!pro && w.clamped ? FREE_WINDOW_NOTE : "") + billedNote;

  if (fmt === "json") {
    return ok(JSON.stringify({
      from: Number.isFinite(w.fromMs) ? iso(new Date(w.fromMs)) : null,
      to: Number.isFinite(w.toMs) ? iso(new Date(w.toMs)) : null,
      group_by: a.group_by ?? null,
      // Codex v3 #27: a scalar amount_cents/currency is emitted only when the bucket
      // holds exactly one currency; mixed buckets expose `amounts` alone.
      rows: buckets.map(b => {
        const parts = nonZero(b.amounts);
        return {
          key: b.key, hours: Number(hours(b.seconds)), seconds: b.seconds,
          billable_hours: Number(hours(b.billableSeconds)),
          ...(parts.length === 1 ? { amount_cents: parts[0][1], currency: parts[0][0] } : {}),
          amounts: parts.map(([c, cents]) => ({ currency: c, amount_cents: cents })),
        };
      }),
      total: {
        hours: Number(hours(totalSec)), seconds: totalSec,
        billable_hours: Number(hours(totals.billableSeconds)),
        ...(totalParts.length === 1 ? { amount_cents: totalParts[0][1], currency: totalParts[0][0] } : {}),
        amounts: totalParts.map(([c, cents]) => ({ currency: c, amount_cents: cents })),
      },
      ...(a.group_by ? {} : { note: "No group_by was given, so this is the plain total for the period; rows is empty." }),
      ...(a.group_by === "tag" ? { note: TAG_OVERLAP_NOTE } : {}),
      unbilled_only: unbilledOnly,
      billed_entries_excluded: hidden,
      tier: pro ? "pro" : "free",
    }, null, 2) + note);
  }
  if (fmt === "csv") {
    const lines = [["key", "hours", "billable_hours", "amount", "currency"].join(",")];
    for (const b of buckets) {
      const parts = nonZero(b.amounts);
      if (parts.length === 0) lines.push([b.key, hours(b.seconds), hours(b.billableSeconds), "0.00", currencyFor(db, b.key)].map(csvCell).join(","));
      // one line per currency: mixed currencies must never be added together
      for (const [cur, cents] of parts) lines.push([b.key, hours(b.seconds), hours(b.billableSeconds), (cents / 100).toFixed(2), cur].map(csvCell).join(","));
    }
    for (const [cur, cents] of (totalParts.length ? totalParts : [[currency, 0] as [string, number]])) {
      lines.push(["TOTAL", hours(totalSec), "", (cents / 100).toFixed(2), cur].map(csvCell).join(","));
    }
    return ok(lines.join("\n") + note);
  }
  if (!a.group_by) {
    if (entries.length === 0) return ok(`No time tracked in that period.${note}`);
    return ok(`Total ${hours(totalSec)} h, ${moneyOf(totals.amounts)}.${mixed}${note}`);
  }
  if (buckets.length === 0) return ok(`No time tracked in that period.${note}`);
  const body = table(
    [a.group_by, "hours", "billable h", "amount"],
    buckets.map(b => [b.key, hours(b.seconds), hours(b.billableSeconds), moneyOf(b.amounts)]),
  );
  const overlap = a.group_by === "tag" ? `\n${TAG_OVERLAP_NOTE}` : "";
  return ok(`${body}\n\nTotal ${hours(totalSec)} h, ${moneyOf(totals.amounts)}.${mixed}${overlap}${note}`);
}));

server.registerTool("export_csv", {
  title: "Export entries to CSV",
  description: "Call this tool to export the timesheet to a CSV file (excel-friendly) you can hand to a bookkeeper: one row per entry with hours, billable, rate, currency and amount. Returns the file path written.",
  inputSchema: {
    from: z.string().optional().describe("ISO date/time lower bound. On the free tier the export is clamped to the last 7 days; Pro exports the full history."),
    to: z.string().optional().describe("ISO date/time upper bound. On the free tier the export is clamped to the last 7 days; Pro exports the full history."),
    project: z.string().optional().describe("Optional project filter"),
    path: z.string().optional().describe("Target file path; a relative path resolves against the working directory. Defaults to a timestamped file in the local data directory, and the full path is returned."),
  },
}, guard(async (a: { from?: string; to?: string; project?: string; path?: string }) => {
  const pro = gate.isPro();
  const db = load();
  const f = resolveFilter(db, a.project);          // Codex v3 #29
  if (f.kind === "ambiguous") return ok(f.text);
  const w = windowFor(a.from, a.to, pro);
  const entries = select(db, w, f.project);
  const header = ["id", "project", "task", "start", "end", "hours", "seconds", "billable", "rate", "currency", "amount", "tags", "note"];
  const lines = [header.join(",")];
  for (const e of entries) {
    const rc = rateForEntry(db, e);
    const cur = currencyForEntry(db, e);
    lines.push([
      e.id, e.project, e.task ?? "", e.start, e.end, hours(e.seconds), String(e.seconds),
      e.billable ? "true" : "false",
      rc > 0 ? (rc / 100).toFixed(2) : "", rc > 0 ? cur : "",
      rc > 0 && e.billable ? (amountCents(e.seconds, rc) / 100).toFixed(2) : "",
      e.tags.join(" "), e.note ?? "",
    ].map(csvCell).join(","));
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const target = a.path
    ? (isAbsolute(a.path) ? a.path : pathResolve(process.cwd(), a.path))
    : join(dataDir(), `time-entries-${stamp}.csv`);
  const dir = dirname(target);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = `${target}.${process.pid}.tmp`;
  writeFileSync(tmp, lines.join("\n") + "\n");
  renameSync(tmp, target);
  const note = !pro && w.clamped ? FREE_WINDOW_NOTE : "";
  return ok(`Wrote ${entries.length} entries to ${target}${note}`);
}));

server.registerTool("entry_mark_billed", {
  title: "Mark time entries as billed",
  description: "Close the loop after an invoice is issued: stamp the tracked hours that went on it with the invoice number, so report and invoice_summary stop offering them and the same hours are never billed twice.",
  inputSchema: {
    ids: z.array(z.string()).optional().describe("Exact entry ids, normally the entry_ids invoice_summary returned. Pass either ids or project plus from and to. Entries already billed are left alone and listed back to you."),
    project: z.string().optional().describe("Project or client, used with from and to instead of ids; every billable entry in that range is stamped."),
    from: z.string().optional().describe("ISO date/time start of the billed period, used with project"),
    to: z.string().optional().describe("ISO date/time end of the billed period, used with project"),
    invoice_number: z.string().min(1).describe("The invoice these hours were put on, e.g. INV-2026-0001"),
    billed_at: z.string().optional().describe("ISO timestamp of the stamp, defaults to now"),
  },
}, guard(async (a: { ids?: string[]; project?: string; from?: string; to?: string; invoice_number: string; billed_at?: string }) => {
  return withFileLock(LOCK, async () => {
  const db = load();
  const stamp = a.billed_at ? iso(parseTime(a.billed_at, "billed_at")) : iso(new Date());
  let targets: Entry[];
  if (a.ids && a.ids.length) {
    const wanted = new Set(a.ids);
    targets = db.entries.filter(e => wanted.has(e.id));
    const missing = a.ids.filter(id => !db.entries.some(e => e.id === id));
    if (missing.length) return err(`no entry with id ${missing.join(", ")}. Nothing was marked; run entry_list or invoice_summary for current ids.`);
  } else {
    if (!a.project || !a.from || !a.to) {
      return err(`pass either ids: ["..."] or project plus from and to. entry_mark_billed {ids: <entry_ids from invoice_summary>, invoice_number: "${a.invoice_number}"} is the usual call.`);
    }
    const r = resolveProject(db, a.project);
    if (r.kind === "ambiguous") return ok(ambiguousText(a.project, r.candidates));
    // The window is deliberately unclamped: under-marking on the free tier would let the
    // same hours onto a second invoice, which is the defect this tool exists to close.
    const w = windowFor(a.from, a.to, true);
    const picked = new Set(select(db, w, r.project).filter(e => e.billable).map(e => e.id));
    targets = db.entries.filter(e => picked.has(e.id));
  }
  if (targets.length === 0) return ok("No entries matched, nothing marked.");
  const already = targets.filter(isBilled);
  const fresh = targets.filter(e => !isBilled(e));
  for (const e of fresh) { e.billed_at = stamp; e.billed_invoice = a.invoice_number; }
  if (fresh.length) save(db);
  const sec = fresh.reduce((s, e) => s + e.seconds, 0);
  const amounts = new Map<string, number>() as Amounts;
  for (const e of fresh) if (e.billable) addAmount(amounts, currencyForEntry(db, e), amountCents(e.seconds, rateForEntry(db, e)));
  const lines = [
    `Marked ${fresh.length} ${fresh.length === 1 ? "entry" : "entries"} as billed on ${a.invoice_number}: ${hours(sec)} h${nonZero(amounts).length ? `, ${moneyOf(amounts)}` : ""}.`,
    `ids: ${JSON.stringify(fresh.map(e => e.id))}`,
  ];
  if (already.length) {
    lines.push(`Left alone, already billed: ${already.map(e => `${e.id} on ${e.billed_invoice}`).join(", ")}.`);
  }
  lines.push(`report and invoice_summary now skip these hours; pass unbilled_only: false to see them again.`);
  return ok(lines.join("\n"));
  });
}));

server.registerTool("invoice_summary", {
  title: "Invoice summary",
  description: "Turn tracked billable time into invoice line items for one project or client: hours, hourly rate, amount per task and the total, in the currency the work was logged in (EUR 225.00, not $225.00).",
  inputSchema: {
    project: z.string().min(1).describe("Project or client to invoice"),
    from: z.string().describe("ISO date/time start of the billing period. Free covers the last 7 days; Pro invoices any period from the full history."),
    to: z.string().describe("ISO date/time end of the billing period. Free covers the last 7 days; Pro invoices any period from the full history."),
    unbilled_only: z.boolean().optional().describe("Default true: hours already put on an invoice (entry_mark_billed) are left out, so the same hours are never billed twice. Pass false to see the whole period including invoiced work."),
  },
}, guard(async (a: { project: string; from: string; to: string; unbilled_only?: boolean }) => {
  // Free within the 7-day window: this tool is the answer to "give me invoice lines",
  // and a first free session should not have to rebuild it from entry_list + report (D-11).
  const pro = gate.isPro();
  const db = load();
  const r = resolveProject(db, a.project);         // Codex v3 #29
  if (r.kind === "ambiguous") return ok(ambiguousText(a.project, r.candidates));
  const w = windowFor(a.from, a.to, pro);
  const unbilledOnly = a.unbilled_only !== false;          // D-R28: default true
  const billableAll = select(db, w, r.project).filter(e => e.billable);
  const entries = unbilled(billableAll, unbilledOnly);
  const hidden = billableAll.length - entries.length;
  const billedNote = hidden > 0 ? BILLED_NOTE(hidden) : "";
  if (entries.length === 0) {
    return ok(`No billable time for "${r.project}" in that period.` + (!pro && w.clamped ? FREE_WINDOW_NOTE : "") + billedNote);
  }
  // D-R1: one line per (task, rate, currency). Grouping by task alone blends two
  // rates into an average - EUR 89.82 for work agreed at EUR 90.00 - which is a
  // number nobody signed and cannot go on an invoice. Entries with no task get
  // their own line per rate for the same reason.
  interface Line { task: string; rateCents: number; currency: string; seconds: number; cents: number }
  const byRate = new Map<string, Line>();
  for (const e of entries) {
    const rateCents = rateForEntry(db, e);
    const currency = currencyForEntry(db, e);
    const task = e.task ?? "(no task)";
    const key = `${task}\u0000${rateCents}\u0000${currency}`;
    const l = byRate.get(key) ?? { task, rateCents, currency, seconds: 0, cents: 0 };
    l.seconds += e.seconds;
    l.cents += amountCents(e.seconds, rateCents);
    byRate.set(key, l);
  }
  const lines = [...byRate.values()].sort((a, b) => b.seconds - a.seconds);
  const totalSec = lines.reduce((s, l) => s + l.seconds, 0);
  const totals = new Map<string, number>() as Amounts;
  for (const l of lines) addAmount(totals, l.currency, l.cents);
  const rows = lines.map(l => [
    l.task,
    hours(l.seconds),
    l.rateCents > 0 ? `${money(l.rateCents, l.currency)}/h` : "-",
    l.cents > 0 ? money(l.cents, l.currency) : "-",
  ]);
  const body = table(["description", "hours", "rate", "amount"], rows);
  const days = [...new Set(entries.map(e => dayKey(e.start)))].sort();
  // D-R28: the ids are part of the answer. Whoever turns these lines into an invoice has
  // to hand them back to entry_mark_billed, or the same hours are billed again next month.
  const entryIds = [...new Set(entries.map(e => e.id))];
  return ok(
    `Invoice summary - ${r.project}\n` +
    `Period ${dayKey(a.from)} to ${dayKey(a.to)} (${days.length} working days, ${entries.length} entries)\n\n` +
    `${body}\n\nTOTAL ${hours(totalSec)} h  ${moneyOf(totals)}\n\n` +
    `entry_ids: ${JSON.stringify(entryIds)}\n` +
    `After the invoice exists, call entry_mark_billed {ids: <these entry_ids>, invoice_number: "<the new invoice number>"} ` +
    `so these hours are not billed a second time.` +
    (!pro && w.clamped ? FREE_WINDOW_NOTE : "") + billedNote,
  );
}));

/* ------------------------------------------------------- resource + prompt */

/** Codex v3 #22/#23: the day gets the part of each entry that falls inside it. */
function daySummary(db: DB, key: string): string {
  const [y, m, d] = key.split("-").map(Number);
  const entries = select(db, { fromMs: new Date(y, m - 1, d).getTime(), toMs: new Date(y, m - 1, d + 1).getTime() - 1, clamped: false });
  const sec = entries.reduce((s, e) => s + e.seconds, 0);
  if (entries.length === 0) return `${key}: nothing tracked.`;
  const byProject = aggregate(db, entries, "project");
  const totals = totalsOf(db, entries).amounts;
  const detail = byProject.map(b => `  ${b.key}: ${hours(b.seconds)} h${nonZero(b.amounts).length ? ` (${moneyOf(b.amounts)})` : ""}`).join("\n");
  return `${key}: ${hours(sec)} h across ${entries.length} entries${nonZero(totals).length ? `, ${moneyOf(totals)}` : ""}\n${detail}`;
}

server.registerResource("today", "timetracker://today", {
  title: "Today's tracked time",
  description: "Summary of time tracked today, by project, including any running timer.",
  mimeType: "text/plain",
}, async (uri: URL) => {
  const db = load();
  const key = dayKey(new Date().toISOString());
  let text = daySummary(db, key);
  if (db.running) {
    const sec = Math.round((Date.now() - new Date(db.running.start).getTime()) / 1000);
    text += `\nRunning now: ${db.running.project}${db.running.task ? ` - ${db.running.task}` : ""} for ${hms(sec)}`;
  }
  return { contents: [{ uri: uri.href, mimeType: "text/plain", text }] };
});

server.registerPrompt("daily_standup", {
  title: "Daily standup",
  description: "Write a standup update from the time tracked yesterday and today.",
  argsSchema: { audience: z.string().optional().describe("Who the update is for, e.g. 'client' or 'team'") },
}, ({ audience }: { audience?: string }) => {
  const db = load();
  const today = dayKey(new Date().toISOString());
  const y = new Date(); y.setDate(y.getDate() - 1);
  const yesterday = dayKey(y.toISOString());
  const tasks = db.entries
    .filter(e => dayKey(e.start) === today || dayKey(e.start) === yesterday)
    .map(e => `- ${dayKey(e.start)} ${e.project}: ${e.task ?? "(no task)"} ${hours(e.seconds)} h${e.note ? ` - ${e.note}` : ""}`)
    .join("\n") || "(no entries)";
  const text =
    `Write a short standup update${audience ? ` for ${audience}` : ""} from my tracked time.\n\n` +
    `YESTERDAY\n${daySummary(db, yesterday)}\n\nTODAY\n${daySummary(db, today)}\n\n` +
    `ENTRIES\n${tasks}\n\n` +
    `Format: "Yesterday:" bullets of what was done, "Today:" what is in progress, ` +
    `"Blockers:" only if a note implies one. Keep it under 120 words, plain language, no filler.`;
  return { messages: [{ role: "user" as const, content: { type: "text" as const, text } }] };
});

/* ------------------------------------------------------------------ boot */

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(`mcp-time-tracker ready (${gate.isPro() ? "pro" : "free"}), data in ${dataDir()}\n`);
}

main().catch(e => {
  process.stderr.write(`fatal: ${e instanceof Error ? e.stack : String(e)}\n`);
  process.exit(1);
});
