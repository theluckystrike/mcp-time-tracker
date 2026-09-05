import { readSharedProfile } from "@theluckystrike/mcp-license";

/**
 * Local calendar-day helpers. Extracted from index.ts so the other servers can be tested
 * against the same definition of "today" (D-R15): invoice's isoDate(), expense-tracker's
 * localDay() and this must all return the same string for the same process TZ.
 *
 * D-R35: when the shared business profile carries a `timezone`, that is the user's home
 * zone and every day boundary is computed in it, not in the host machine's zone. A round-8
 * entry logged at 09:00 Warsaw on a UTC+07 machine landed on 04:00 Warsaw; near midnight it
 * would have landed on the wrong day and been sliced into the wrong week by report{from,to}.
 */

let zoneCache: { raw: string | undefined; zone: string | undefined } | null = null;

/** The home zone from the shared profile, or undefined when none is set or it is not a real zone. */
export function homeZone(): string | undefined {
  const raw = readSharedProfile().timezone;
  if (zoneCache && zoneCache.raw === raw) return zoneCache.zone;
  let zone: string | undefined;
  if (raw) {
    try { new Intl.DateTimeFormat("en-CA", { timeZone: raw }); zone = raw; }
    catch { zone = undefined; }
  }
  zoneCache = { raw, zone };
  return zone;
}

/** Test seam: drop the memoised zone after the profile changes inside one process. */
export function resetZoneCache(): void { zoneCache = null; }

const p2 = (n: number) => String(n).padStart(2, "0");

/** Offset (ms) of `zone` from UTC at instant `d`. */
function zoneOffsetMs(d: Date, zone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone, hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(d);
  const v: Record<string, number> = {};
  for (const p of parts) if (p.type !== "literal") v[p.type] = Number(p.value);
  const asUtc = Date.UTC(v.year, v.month - 1, v.day, v.hour % 24, v.minute, v.second);
  return asUtc - Math.floor(d.getTime() / 1000) * 1000;
}

/** The instant of wall-clock midnight on Y-M-D in `zone`. Two passes settle DST. */
function zoneMidnight(y: number, m: number, d: number, zone: string): Date {
  const wall = Date.UTC(y, m - 1, d, 0, 0, 0);
  let guess = new Date(wall - zoneOffsetMs(new Date(wall), zone));
  guess = new Date(wall - zoneOffsetMs(guess, zone));
  return guess;
}

/** Local-timezone day key, YYYY-MM-DD. Uses the profile's home zone when one is set. */
export function dayKey(isoStr: string, zone = homeZone()): string {
  const d = new Date(isoStr);
  if (zone) {
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(d);
    const v: Record<string, string> = {};
    for (const p of parts) if (p.type !== "literal") v[p.type] = p.value;
    return `${v.year}-${v.month}-${v.day}`;
  }
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
}

/**
 * Wall clock HH:MM at that instant in the home zone. D-R67: dayKey() has been zone-aware
 * since D-R35, but the clock beside it came from the host process zone, so a hosted row
 * read "2026-09-03  07:00" for work the caller logged at 09:00 Warsaw - the day in one
 * zone, the time in another, in the same row.
 */
export function hhmm(isoStr: string, zone = homeZone()): string {
  const d = new Date(isoStr);
  if (zone) {
    const parts = new Intl.DateTimeFormat("en-GB", { timeZone: zone, hour12: false, hour: "2-digit", minute: "2-digit" }).formatToParts(d);
    const v: Record<string, string> = {};
    for (const p of parts) if (p.type !== "literal") v[p.type] = p.value;
    return `${v.hour === "24" ? "00" : v.hour}:${v.minute}`;
  }
  return `${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

/** Today on the local calendar, YYYY-MM-DD. */
export function localToday(): string {
  return dayKey(new Date().toISOString());
}

/** Start of local day N days back, as a Date. */
export function localDayStart(daysBack = 0, zone = homeZone()): Date {
  if (zone) {
    const [y, m, d] = dayKey(new Date().toISOString(), zone).split("-").map(Number);
    return zoneMidnight(y, m, d - daysBack, zone);
  }
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - daysBack);
  return d;
}

/**
 * Resolve a wall-clock timestamp with no offset ("2026-09-02T09:00:00" or "2026-09-02")
 * in the home zone. A string carrying an explicit offset or a trailing Z returns null:
 * the caller already said which instant it means.
 */
export function wallClockInZone(s: string, zone = homeZone()): Date | null {
  if (!zone) return null;
  const t = String(s).trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?)?$/.exec(t);
  if (!m) return null;
  const [, y, mo, d, hh, mi, ss] = m;
  const midnight = zoneMidnight(Number(y), Number(mo), Number(d), zone);
  const offsetSec = (Number(hh ?? 0) * 3600) + (Number(mi ?? 0) * 60) + Number(ss ?? 0);
  return new Date(midnight.getTime() + offsetSec * 1000);
}
