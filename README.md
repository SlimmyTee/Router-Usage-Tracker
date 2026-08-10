# Router Usage Tracker

Tracks real cumulative internet usage across one or more home routers by
polling each router's own admin interface and accumulating the readings
in a local SQLite database. Router traffic counters reset to zero on
every reboot — this tool turns them into reliable running totals with
per-router, daily, monthly, and yearly breakdowns.

```
=== All-time (since tracker started) ===
Airtel      down 82.386 GB    up 15.857 GB    total 98.243 GB
MTN Fibre   down 8.721 GB     up 1.088 GB     total 9.809 GB
MTN Router  down 16.946 GB    up 10.601 GB    total 27.547 GB
ALL         down 108.054 GB   up 27.545 GB    total 135.599 GB
```

## How it works

- `poller.js` reads your routers from `.env` and polls each one through
  a **router-type adapter** (see `adapters/`). Each adapter logs into
  its router however that firmware requires and returns normalized
  cumulative counters: `down` = data delivered to your devices,
  `up` = data sent out.
- `db.js` compares each reading to the last one stored per
  router+counter. If the counter went *up*, the difference is added to
  today's total; if it went *down* (the router rebooted, or cleared its
  own counter on its monthly reset day), the new reading is treated as
  fresh usage — so a counter reset never loses recorded data or goes
  negative.
- Data lives in `data/usage.sqlite` (inspect with any SQLite browser).
- `report.js` prints all-time per-router + combined totals, plus daily
  (30 days), monthly (12 months), and yearly rollups.

## Supported routers

| Type | Device | Method |
|---|---|---|
| `huawei-hg8145x7` | Huawei OptiXstar HG8145X7-10 (MTN GPON ONT) | Headless browser (Playwright) — logs into the web UI, reads the per-band counters the WLAN info page embeds as JS variables. Counts Wi-Fi traffic per band (2.4GHz / 5GHz). |
| `airtel-httpcgi` | Airtel CPE ("Highwmg" Vue firmware) | Plain HTTP — token + `sha256(token+password)` login against the JSON API at `/cgi-bin/http.cgi`, then reads WAN byte counters (cmd 18). |
| `zte-zwrt` | ZTE OpenWrt-based CPE (e.g. MC8830 5G) | Plain HTTP — salted double-SHA256 login (password only, no username) over ubus JSON-RPC at `/ubus/`, then reads this-month WAN counters (`zwrt_data get_wwandst`). |

## Setup

```bash
npm install
npx playwright install chromium   # only needed for browser-based adapters
cp .env.example .env              # then fill in your routers + credentials
```

## Usage

```bash
npm run poll            # poll every configured router
node poller.js airtel   # poll just one router by its key
npm run report          # totals + daily/monthly/yearly breakdowns
npm run dashboard       # local web dashboard (opens in your browser)
npm run poll:debug      # browser-based adapters run headful, for debugging
```

The dashboard (`dashboard.js` + `dashboard.html`) is a dependency-free
local server on `http://localhost:8787` (`PORT` env var to change) that
reads the SQLite file directly: stat tiles for this-month/all-time/
per-router totals, stacked daily and monthly charts with hover
breakdowns, a monthly table, and per-router last-poll freshness (⚠ stale
if a router hasn't been polled in 45 min). It auto-refreshes every
minute and follows your system's light/dark mode. On macOS it opens the
browser automatically (set `NO_OPEN=1` to suppress).

Routers are declared in `.env`: a stable lowercase key per router in
`ROUTERS` (this is what the database stores), plus `<KEY>_TYPE`, `_URL`,
credentials, and an optional `<KEY>_NAME` display name shown in reports —
rename freely without losing history.

A router that's unreachable or misconfigured is skipped with an error;
the others still get polled. This matters because a machine connected to
one router's Wi-Fi usually can't reach the other router's LAN — run the
poller on a device that can reach them all (or accept that each network's
usage only accrues while you're connected to it).

## Scheduling (macOS)

```bash
crontab -e
```

```
*/15 * * * * cd /path/to/this/repo && /usr/local/bin/node poller.js >> data/poller.log 2>&1
```

Use `which node` for the correct node path — cron doesn't load your
shell profile (so an nvm-managed node needs its full versioned path).

To verify it's running: `crontab -l` shows the schedule, and
`tail -20 data/poller.log` should gain a new block of entries every
15 minutes. `Poll failed` lines for routers unreachable from your
current network are normal — the reachable ones still get recorded.

## Writing a new adapter

Create `adapters/<type>.js` exporting:

```js
export async function poll({ url, username, password }) {
  // ...log in, read cumulative byte counters...
  return [
    { counter: "wan", downBytes: 123, upBytes: 45, note: "optional label" },
  ];
}
```

- `counter` names a monotonic counter on that router (a Wi-Fi band, a
  WAN interface…). One router can return several.
- Counters must be **cumulative** (since boot is fine — reboot resets
  are handled), not rates.
- Normalize direction: `down` = toward the household, `up` = outbound.
  Beware: LAN-side counters (like Wi-Fi stats) have TX = download,
  while WAN-side counters have RX = download.

Then register the type in `ADAPTERS` in `poller.js` and document it above.

## Notes / limitations

- Day-one inflation: the first ever poll of a router books everything
  since that router's last reboot into that day. Totals are correct
  from then on.
- Polling captures deltas *between* polls; usage right around a reboot
  that happens between polls is slightly under-counted. Frequent polling
  (e.g. every 15 min) keeps this small.
- Per-router granularity only — no per-device breakdown.
- cron doesn't run while the machine is asleep and doesn't catch up
  afterward. Usage isn't lost (counters are cumulative on the routers) —
  unless a router resets its counter during the gap. An always-on device
  on the LAN is the robust home for the poller.
- `data/poller.log` grows unbounded (roughly 1 MB/month at 15-minute
  polls) — truncate it occasionally or add rotation.
- Credentials live in `.env`, which is gitignored — never commit it.
  Note that Playwright's error logs echo form values on failure, so a
  browser-adapter login failure can leak a password into `poller.log` —
  keep the log private too.
