# mcp-time-tracker

![time-tracker demo](https://raw.githubusercontent.com/theluckystrike/mcp-servers/main/assets/demo-time-tracker.gif)

**One-click install:** download `time-tracker.mcpb` from the [latest release](https://github.com/theluckystrike/mcp-servers/releases/latest) and double-click it in Claude Desktop.

**Hosted endpoint (no install):** `https://mcp.zovo.one/mcp/time-tracker` (streamable-http; send `Authorization: Bearer <Pro key or anonymous token from https://mcp.zovo.one/mcp/token>`).

Read-only mirror of [mcp-servers/servers/time-tracker](https://github.com/theluckystrike/mcp-servers/tree/main/servers/time-tracker). See [MIRROR.md](MIRROR.md).


Track billable time without leaving your AI chat. Say "start a timer on the acme redesign", keep working, then
ask for "my hours this week by project" or "invoice lines for acme in August". It keeps a running timer, lets you
log time you forgot to track, applies your hourly rate per project, and turns the result into a report, a CSV file
or a set of invoice line items. Everything is stored as plain JSON on your own machine.

Built by [theluckystrike](https://github.com/theluckystrike).


**Track billable time from chat and turn it straight into a report or invoice line items -- zero setup, all local.**

## 60-second install

npm publish for `@theluckystrike/mcp-time-tracker` is pending. Until then, the `.mcpb` one-click bundle or a clone+build
is the working path -- both are verified below.

**One-click (.mcpb):** download `time-tracker.mcpb` from the latest release and double-click it in Claude Desktop:
https://github.com/theluckystrike/mcp-servers/releases/latest

**Claude Desktop** (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "time-tracker": {
      "command": "npx",
      "args": ["-y", "@theluckystrike/mcp-time-tracker"]
    }
  }
}
```

**Claude Code:**

```sh
claude mcp add time-tracker -- npx -y @theluckystrike/mcp-time-tracker
```

**Cursor** (`.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "time-tracker": {
      "command": "npx",
      "args": ["-y", "@theluckystrike/mcp-time-tracker"]
    }
  }
}
```

The `npx` form above starts working the moment the package is published. Until then, use the .mcpb bundle above, or
build from source with exactly these three commands:

```sh
git clone https://github.com/theluckystrike/mcp-servers.git && cd mcp-servers
npm install
npm run build -w packages/mcp-license -w servers/time-tracker
```

Then point your client's `command` at `node` with one arg: the absolute path to `servers/time-tracker/dist/index.js`.

To run in Pro mode set `MCP_LICENSE_KEY` in the same config block, or call `license_activate` once with your key.

## Tools

| Tool | What it does |
| --- | --- |
| `timer_start` | Start a timer on a project (optional task, tags, rate, currency). Starting a new one stops and logs the old one. A partial project name that matches exactly one existing project is used as that project. |
| `timer_stop` | Stop the running timer, write the entry, return the duration. |
| `timer_status` | What is running, for how long, and today's total. |
| `entry_add` | Log time you already worked (start plus end or minutes), with an optional rate and currency: rate "90 euros an hour" bills as EUR 225.00 for 2.5 h. Partial project names resolve like `timer_start`. |
| `entry_list` | Compact table of entries, filtered by date range and project. |
| `entry_edit` | Change any field of an entry. |
| `entry_delete` | Delete an entry by id. |
| `project_set_rate` | Set the hourly rate and currency used for money totals (currency accepts codes or words: EUR, euros, pounds, zl). `apply_to_existing: true` re-rates time already logged for that project; add `only_missing: true` to touch only entries that carry no rate. |
| `report` | Hours and money for a period, optionally grouped by project, day, task or tag; omit `group_by` for the plain total per currency. Table, JSON or CSV. Hours already invoiced are left out; pass `unbilled_only: false` for the full timesheet. |
| `export_csv` | Write entries to a CSV file and return the path. |
| `invoice_summary` | Invoice-ready line items for one project: hours, rate, amount, total, in the currency the time was logged in. One line per task and rate, so no line ever shows a blended rate nobody agreed. Returns the `entry_ids` behind the lines, and skips hours already invoiced (`unbilled_only: false` includes them). Free for the last 7 days, Pro for any period from full history. |
| `entry_mark_billed` | Stamp the hours that went on an invoice with its number (`ids` from `invoice_summary`, or `project` + `from` + `to`), so `report` and `invoice_summary` stop offering them and the same hours are never billed twice. |
| `license_status` | Free or Pro, and where to upgrade. |
| `license_activate` | Activate a Pro key (verified offline). |

Also exposed: the resource `timetracker://today` (today's summary) and the prompt `daily_standup`
(writes a standup update from yesterday's and today's tracked time).

## What you can say

No tool names required. These are the sentences that were actually tested against the server; the tool
column is what answered them.

| You say | Tool |
| --- | --- |
| "Start a timer for the Acme website project." | `timer_start` |
| "Stop the timer and tell me how long I worked." | `timer_stop` |
| "What's running right now, and for how long?" | `timer_status` |
| "Log 2.5 hours yesterday for Acme, design review, at 90 euros an hour." | `entry_add` |
| "Show me my Acme entries for this week." | `entry_list` |
| "That last entry should say API refactor, not design review." | `entry_edit` |
| "Delete the entry I just logged twice." | `entry_delete` |
| "Set my rate for Acme to 90 EUR an hour." | `project_set_rate` |
| "How many hours did I bill this month, grouped by project?" | `report` |
| "Give me invoice lines for Acme in August." | `invoice_summary` |
| "I invoiced those hours as INV-2026-0001." | `entry_mark_billed` |

Two more worth knowing: "export my time to a CSV for my bookkeeper" (`export_csv`) and "write my standup
update from yesterday and today" (the `daily_standup` prompt).

## Worked example

This is a real transcript from the audit in `docs/USER_VALUE_R2.md`, numbers unchanged.

```
You: Log 2.5 hours yesterday for Acme, design review, at 90 euros an hour.

  entry_add { project: "Acme", ... }
  -> "Acme" resolved to the existing project "Acme website"
  -> rate "90 euros an hour" parsed as EUR 90.00/h

Assistant: Logged 2.50 h for Acme website - design review at EUR 90.00/h = EUR 225.00.

You: How much do I bill Acme this week? Give me invoice lines.

  invoice_summary { project: "Acme website", from: "2026-08-31", to: "2026-09-02" }

Assistant: Invoice summary - Acme website
  design review    2.50 h   EUR 90.00/h   EUR 225.00
  TOTAL            2.50 h                 EUR 225.00
```

One call each. The rate carries its currency all the way through: the report never prints a bare "225",
and it never turns into "$225" by accident.

A second worked example, the weekly report and the `daily_standup` prompt:

```
You: How many hours did I put into Acme this week, grouped by task?

  report { project: "Acme website", from: "2026-08-27", to: "2026-09-02", group_by: "task" }

Assistant: Acme website, 2026-08-27 to 2026-09-02
  design review   2.50 h   EUR 225.00
  TOTAL           2.50 h   EUR 225.00

You: Write my standup update.

  (prompt) daily_standup

Assistant: Yesterday: 2.50 h on Acme website (design review).
Today: nothing logged yet.
```

### Billed hours close

An hour that has been invoiced is finished. `entry_mark_billed {ids, invoice_number}` writes
`billed_at` and `billed_invoice` onto those entries; from then on `report` and `invoice_summary`
skip them by default, so next month's "invoice Acme" cannot re-bill work already paid for. The
whole timesheet is still there: pass `unbilled_only: false` to any of them. `invoice_summary`
returns the `entry_ids` it used precisely so they can be handed straight to `entry_mark_billed`
once the invoice exists.

`report` and `invoice_summary` answer overlapping questions on purpose: `report` is for "how much time
and money," grouped any way you like; `invoice_summary` is for "give me the lines I can put on an
invoice," which is a narrower, invoice-shaped view of the same entries for one project.

## How it stores data

Entries, projects and rates live in one JSON file:
`${XDG_DATA_HOME:-~/.local/share}/mcp-servers/time-tracker/data.json`.

Every write (starting or stopping a timer, adding, editing or deleting an entry, setting a rate) happens
under an advisory lock file at `.../time-tracker/.lock`, held across the whole load-mutate-save cycle, so
two overlapping calls cannot interleave and corrupt the file. The save itself writes to a temporary file
and renames it into place, so a crash or a killed process mid-write leaves either the old file or the new
one, never a half-written one. Reads (`entry_list`, `report`, `timer_status`, `export_csv`) do not take
the lock.

To back up your data, copy the single `data.json` file (and `.lock` if present, though it holds no data).
There is no database and no hidden second file.

If `data.json` is ever unreadable or not valid JSON, the server does **not** treat that as "no data yet".
It moves the file aside byte-for-byte as `data.json.corrupt-<timestamp>`, writes a `data.json.corrupt`
marker and makes every tool -- reads included -- return `data file is corrupt; moved to ...; nothing was
written`. Restore a good `data.json` (the quarantined copy is right there) and delete the marker file to
carry on. Nothing is overwritten in the meantime.

## Dates, times and rates

- **Timestamps with no offset are your local time.** `2026-09-02T09:00:00` means 09:00 where you are, not
  UTC. Pass an explicit offset (`2026-09-02T09:00:00+02:00`) or a trailing `Z` and it is honoured exactly.
- **Date-only bounds cover whole local days.** `from: "2026-09-01"` is 00:00:00 local on the 1st and
  `to: "2026-09-30"` is 23:59:59.999 local on the 30th, so a month reported by dates includes its last
  day. Timestamps with a time are used as given.
- **Entries are clipped to the window.** An entry that starts before `from` or ends after `to` counts for
  the part inside the period, not all of it and not none of it.
- **Entries are split at local midnight for day grouping.** Work from 23:30 to 01:30 is 0.5 h on the first
  day and 1.5 h on the next, including across a month boundary. `timer_status` counts only the part of an
  entry -- or of the running timer -- that falls after midnight today.
- **Rate strings are parsed, never guessed.** `"1,200 USD"` is 1200 (a comma followed by exactly three
  digits is thousands grouping), `"12,50 EUR"` is 12.50 (the unambiguous European decimal shape), and
  `"1.200,50"` is 1200.50. Anything that could mean either thing, such as `"1,2345"`, is refused with a
  worked example instead of being read as the wrong number.
- **Rates are captured when the time is logged.** `entry_add` and `timer_stop` store the effective hourly
  rate and currency on the entry, and reports and invoices use that stored rate. `project_set_rate`
  therefore applies to future entries only; pass `apply_to_existing: true` to re-rate the time already
  logged for that project. That re-stamps EVERY entry of the project, including entries that already
  carry a rate, and the response says how many changed and the project's new total. Add
  `only_missing: true` to touch only entries that captured no rate of their own.
- **Tag rows overlap.** In `group_by: "tag"` an entry tagged `dev` and `meeting` appears in both rows; the
  total is computed from the entries once, so it is never the sum of the rows.

## Limits and honest caveats

- Free `entry_list`, `report`, `export_csv` and `invoice_summary` only see the last 7 days. Timers and
  entries themselves are unlimited and nothing is ever deleted -- the window just narrows what a free
  call can read back.
- Free tier supports hourly rates on 2 projects; a third rated project needs Pro.
- Every `report` grouping is free, tag included: the tag total is a correctness fix, not a premium
  feature. `group_by` itself is optional -- omit it for the plain total per currency.
- Only one timer can run at a time. Starting a second one stops and logs the first -- there is no
  concurrent-timer mode.
- There is no reminder or idle-detection: if you forget to stop a timer, it keeps running until you stop
  it or start another.

## Troubleshooting

- **`npx` hangs or fails to find the package**: npm publish for this package is pending. Use the `.mcpb`
  bundle or the clone-and-build path above until it lands.
- **Using the `.mcpb` bundle**: it installs into Claude Desktop directly; there is no separate path to
  configure.
- **Using the clone path**: the server binary is `servers/time-tracker/dist/index.js` after
  `npm run build`. Point your client's `command` at `node` with that absolute path as the only argument.
- **Node version**: requires Node >= 18. Check with `node -v`.
- **Nothing shows up / silent failures**: this server writes logs to stderr only, never stdout (stdout is
  reserved for the MCP protocol). In Claude Desktop, check Settings -> Developer -> the server's log
  file; in Claude Code, run with `--mcp-debug` or check the terminal you launched it from.
- **A Pro key isn't recognized**: run `license_status` to see what the server thinks your tier is, and
  confirm `MCP_LICENSE_KEY` is set in the same process the client launches (not just your shell).

## Privacy

All data stays local: entries live in `${XDG_DATA_HOME:-~/.local/share}/mcp-servers/time-tracker/data.json`.
The server makes no network requests, has no telemetry, and needs no account. License keys are Ed25519
signatures verified offline against a public key compiled into the package -- activation works with no
internet connection.

## Pairs with

- [mcp-invoice](../invoice/README.md) -- turn `invoice_summary` output straight into a numbered PDF invoice.
- [mcp-spreadsheet](../spreadsheet/README.md) -- export a CSV with `export_csv` and query or reshape it.
- [mcp-price-tracker](../price-tracker/README.md) -- if you also buy things for the client, watch those prices.
- [office-suite](../office-suite/README.md) -- all four servers behind one install, one config entry.
- Guide: [Track billable hours in Claude Code and Cursor](https://mcp.zovo.one/guides/track-time-in-claude-code)

## FAQ

**Does this work in Cursor as well as Claude Code and Claude Desktop?**
Yes. All three speak MCP over stdio with the same config shape; the tools and the data file are identical
regardless of client.

**What happens when the free 7-day window runs out on an old entry?**
Nothing is deleted. The entry stays in `data.json` forever; it just will not appear in `entry_list`,
`report`, `export_csv` or `invoice_summary` results until you activate Pro, which opens full history.

**Can I bill different clients in different currencies?**
Yes. Currency is set per project (or per entry, overriding the project default) and every total is grouped
by currency -- a report never adds EUR and USD together.

**What happens if two entries have overlapping times?**
The server does not block overlaps; it logs what you tell it. `entry_edit` lets you fix a mistake after
the fact.

**Does it need an internet connection?**
No. There are no network calls anywhere in this server, including for license activation, which is
verified with a local public key.

## License

MIT

## One business profile for the whole suite

Your identity is stored once, at `${XDG_DATA_HOME:-~/.local/share}/mcp-servers/profile/business.json`,
and every server in the suite reads it: the invoice issuer, the docx letterhead, the recurring
issuer, expense-tracker's default VAT rate, time-tracker's and timezone's home zone, and the
resume and contract letterheads. Set it once with `business_set` (invoice or docx) - you never
repeat it anywhere else. An email address is only ever taken from that profile or from an explicit
argument; when none is stored, documents show `[add: email]` and the tool says so rather than
letting anyone improvise an address.
