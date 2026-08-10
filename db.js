import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, "data");
fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, "usage.sqlite"));
db.pragma("journal_mode = WAL");

// Direction is normalized across adapters: down = data delivered to the
// household (download), up = data sent out (upload). Each adapter maps
// its router's RX/TX convention onto this.
db.exec(`
  -- Every raw poll result, normalized per router+counter — audit trail.
  CREATE TABLE IF NOT EXISTS raw_readings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,            -- ISO timestamp of the poll
    router TEXT NOT NULL,        -- router name from .env (e.g. 'mtn')
    counter TEXT NOT NULL,       -- counter within the router (e.g. '2.4GHz', 'wan')
    down_bytes INTEGER NOT NULL,
    up_bytes INTEGER NOT NULL
  );

  -- Last raw counter seen per router+counter, so we can compute deltas
  -- and detect resets (counter goes down after a router reboot).
  CREATE TABLE IF NOT EXISTS last_counter (
    router TEXT NOT NULL,
    counter TEXT NOT NULL,
    down_bytes INTEGER NOT NULL,
    up_bytes INTEGER NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (router, counter)
  );

  -- Running cumulative usage, bucketed by local day, immune to reboots
  -- because we only ever add positive deltas.
  CREATE TABLE IF NOT EXISTS daily_usage (
    date TEXT NOT NULL,          -- YYYY-MM-DD (local date)
    router TEXT NOT NULL,
    counter TEXT NOT NULL,
    down_bytes INTEGER NOT NULL DEFAULT 0,
    up_bytes INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (date, router, counter)
  );
`);

// One-time migration from the single-router schema (rx/tx columns, no
// router dimension). Old data was the MTN router; its rx was upload and
// tx was download from the router's point of view.
function migrateLegacy() {
  const legacy = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='daily_usage'`)
    .get()
    ? db.prepare(`PRAGMA table_info(daily_usage)`).all().every((c) => c.name !== "router")
    : false;
  if (!legacy) return;

  db.transaction(() => {
    db.exec(`
      ALTER TABLE raw_readings RENAME TO raw_readings_legacy;
      ALTER TABLE last_counter RENAME TO last_counter_legacy;
      ALTER TABLE daily_usage RENAME TO daily_usage_legacy;

      CREATE TABLE raw_readings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL,
        router TEXT NOT NULL,
        counter TEXT NOT NULL,
        down_bytes INTEGER NOT NULL,
        up_bytes INTEGER NOT NULL
      );
      CREATE TABLE last_counter (
        router TEXT NOT NULL,
        counter TEXT NOT NULL,
        down_bytes INTEGER NOT NULL,
        up_bytes INTEGER NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (router, counter)
      );
      CREATE TABLE daily_usage (
        date TEXT NOT NULL,
        router TEXT NOT NULL,
        counter TEXT NOT NULL,
        down_bytes INTEGER NOT NULL DEFAULT 0,
        up_bytes INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (date, router, counter)
      );

      INSERT INTO raw_readings (ts, router, counter, down_bytes, up_bytes)
        SELECT ts, 'mtn', band, tx_bytes, rx_bytes FROM raw_readings_legacy;
      INSERT INTO last_counter (router, counter, down_bytes, up_bytes, updated_at)
        SELECT 'mtn', band, tx_bytes, rx_bytes, updated_at FROM last_counter_legacy;
      INSERT INTO daily_usage (date, router, counter, down_bytes, up_bytes)
        SELECT date, 'mtn', band, tx_bytes, rx_bytes FROM daily_usage_legacy;

      DROP TABLE raw_readings_legacy;
      DROP TABLE last_counter_legacy;
      DROP TABLE daily_usage_legacy;
    `);
  })();
  console.log("Migrated legacy single-router data (router='mtn').");
}
migrateLegacy();

const insertRaw = db.prepare(
  `INSERT INTO raw_readings (ts, router, counter, down_bytes, up_bytes) VALUES (?, ?, ?, ?, ?)`
);

const getLast = db.prepare(`SELECT * FROM last_counter WHERE router = ? AND counter = ?`);

const upsertLast = db.prepare(`
  INSERT INTO last_counter (router, counter, down_bytes, up_bytes, updated_at)
  VALUES (@router, @counter, @down_bytes, @up_bytes, @updated_at)
  ON CONFLICT(router, counter) DO UPDATE SET
    down_bytes = excluded.down_bytes,
    up_bytes = excluded.up_bytes,
    updated_at = excluded.updated_at
`);

const upsertDaily = db.prepare(`
  INSERT INTO daily_usage (date, router, counter, down_bytes, up_bytes)
  VALUES (@date, @router, @counter, @down_bytes, @up_bytes)
  ON CONFLICT(date, router, counter) DO UPDATE SET
    down_bytes = down_bytes + excluded.down_bytes,
    up_bytes = up_bytes + excluded.up_bytes
`);

function localDate(now) {
  return new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

/**
 * Record one poll reading for a router's counter, updating cumulative
 * totals. Handles counter resets (e.g. router reboot) by treating the
 * new value as a fresh delta rather than going negative.
 */
export function recordReading(router, counter, downBytes, upBytes) {
  const now = new Date();
  const ts = now.toISOString();
  const date = localDate(now);

  insertRaw.run(ts, router, counter, downBytes, upBytes);

  const prev = getLast.get(router, counter);

  let downDelta = downBytes;
  let upDelta = upBytes;
  let resetDetected = false;

  if (prev) {
    if (downBytes >= prev.down_bytes && upBytes >= prev.up_bytes) {
      downDelta = downBytes - prev.down_bytes;
      upDelta = upBytes - prev.up_bytes;
    } else {
      // Counter went backwards -> router rebooted and reset stats.
      // Treat the current reading as usage accrued since the reset.
      resetDetected = true;
    }
  }

  upsertDaily.run({ date, router, counter, down_bytes: downDelta, up_bytes: upDelta });
  upsertLast.run({ router, counter, down_bytes: downBytes, up_bytes: upBytes, updated_at: ts });

  return { downDelta, upDelta, resetDetected };
}

export function getAllTimeByRouter() {
  return db
    .prepare(
      `SELECT router, SUM(down_bytes) AS down_bytes, SUM(up_bytes) AS up_bytes
       FROM daily_usage GROUP BY router ORDER BY router`
    )
    .all();
}

export function getDailyTotals(days = 30) {
  return db
    .prepare(
      `SELECT date, router,
              SUM(down_bytes) AS down_bytes,
              SUM(up_bytes) AS up_bytes
       FROM daily_usage
       GROUP BY date, router
       ORDER BY date DESC
       LIMIT ?`
    )
    .all(days * 8); // generous row cap; report groups by date
}

export function getMonthlyTotals(months = 12) {
  return db
    .prepare(
      `SELECT substr(date, 1, 7) AS month, router,
              SUM(down_bytes) AS down_bytes,
              SUM(up_bytes) AS up_bytes
       FROM daily_usage
       GROUP BY month, router
       ORDER BY month DESC
       LIMIT ?`
    )
    .all(months * 8);
}

export function getYearlyTotals() {
  return db
    .prepare(
      `SELECT substr(date, 1, 4) AS year, router,
              SUM(down_bytes) AS down_bytes,
              SUM(up_bytes) AS up_bytes
       FROM daily_usage
       GROUP BY year, router
       ORDER BY year DESC`
    )
    .all();
}

export default db;
