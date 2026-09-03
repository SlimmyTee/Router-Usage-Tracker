import "dotenv/config";
import { createClient } from "@libsql/client";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import os from "node:os";

const dbUrl = process.env.TURSO_DATABASE_URL;
const dbToken = process.env.TURSO_AUTH_TOKEN;

let client;
if (dbUrl) {
  client = createClient({
    url: dbUrl,
    authToken: dbToken,
  });
} else {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const dataDir = path.join(__dirname, "data");
  fs.mkdirSync(dataDir, { recursive: true });
  const localPath = path.join(dataDir, "usage.sqlite");

  client = createClient({
    url: `file:${localPath}`,
  });
}

// Create tables schema
const schema = [
  `CREATE TABLE IF NOT EXISTS raw_readings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    router TEXT NOT NULL,
    counter TEXT NOT NULL,
    down_bytes INTEGER NOT NULL,
    up_bytes INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS last_counter (
    router TEXT NOT NULL,
    counter TEXT NOT NULL,
    down_bytes INTEGER NOT NULL,
    up_bytes INTEGER NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (router, counter)
  )`,
  `CREATE TABLE IF NOT EXISTS daily_usage (
    date TEXT NOT NULL,
    router TEXT NOT NULL,
    counter TEXT NOT NULL,
    down_bytes INTEGER NOT NULL DEFAULT 0,
    up_bytes INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (date, router, counter)
  )`,
  `CREATE TABLE IF NOT EXISTS device_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    router TEXT NOT NULL,
    mac TEXT NOT NULL,
    ip TEXT NOT NULL,
    hostname TEXT NOT NULL,
    interface TEXT NOT NULL,
    ssid TEXT,
    rssi INTEGER,
    UNIQUE(ts, router, mac)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_device_history_ts ON device_history(ts)`,
  `CREATE INDEX IF NOT EXISTS idx_device_history_mac ON device_history(mac)`,
  `CREATE TABLE IF NOT EXISTS poller_locks (
    router TEXT PRIMARY KEY,
    locked_by TEXT NOT NULL,
    locked_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  )`
];

let dbInitialized = false;
let initPromise = null;

export async function ensureDbInitialized() {
  if (dbInitialized) return;
  if (!initPromise) {
    initPromise = (async () => {
      // If using Turso, assume tables are already set up (e.g. from imported SQLite)
      // to prevent redundant HTTP round-trips on every serverless cold start.
      if (process.env.TURSO_DATABASE_URL) {
        dbInitialized = true;
        return;
      }

      try {
        for (const stmt of schema) {
          await client.execute(stmt);
        }
        try {
          await client.execute("PRAGMA journal_mode = WAL");
        } catch (err) {
          console.warn("Could not set WAL mode:", err.message);
        }
        await migrateLegacy();
        dbInitialized = true;
      } catch (err) {
        initPromise = null;
        console.error("Database lazy initialization failed:", err);
        throw err;
      }
    })();
  }
  return initPromise;
}

// One-time migration from the single-router schema (rx/tx columns, no router dimension)
async function migrateLegacy() {
  const legacyCheck = await client.execute(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='daily_usage'"
  );
  if (legacyCheck.rows.length === 0) return;

  const columnsCheck = await client.execute("PRAGMA table_info(daily_usage)");
  const legacy = columnsCheck.rows.every((c) => c.name !== "router");
  if (!legacy) return;

  await client.batch([
    "ALTER TABLE raw_readings RENAME TO raw_readings_legacy",
    "ALTER TABLE last_counter RENAME TO last_counter_legacy",
    "ALTER TABLE daily_usage RENAME TO daily_usage_legacy",
    `CREATE TABLE raw_readings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,
      router TEXT NOT NULL,
      counter TEXT NOT NULL,
      down_bytes INTEGER NOT NULL,
      up_bytes INTEGER NOT NULL
    )`,
    `CREATE TABLE last_counter (
      router TEXT NOT NULL,
      counter TEXT NOT NULL,
      down_bytes INTEGER NOT NULL,
      up_bytes INTEGER NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (router, counter)
    )`,
    `CREATE TABLE daily_usage (
      date TEXT NOT NULL,
      router TEXT NOT NULL,
      counter TEXT NOT NULL,
      down_bytes INTEGER NOT NULL DEFAULT 0,
      up_bytes INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (date, router, counter)
    )`,
    `INSERT INTO raw_readings (ts, router, counter, down_bytes, up_bytes)
      SELECT ts, 'mtn', band, tx_bytes, rx_bytes FROM raw_readings_legacy`,
    `INSERT INTO last_counter (router, counter, down_bytes, up_bytes, updated_at)
      SELECT 'mtn', band, tx_bytes, rx_bytes, updated_at FROM last_counter_legacy`,
    `INSERT INTO daily_usage (date, router, counter, down_bytes, up_bytes)
      SELECT date, 'mtn', band, tx_bytes, rx_bytes FROM daily_usage_legacy`,
    "DROP TABLE raw_readings_legacy",
    "DROP TABLE last_counter_legacy",
    "DROP TABLE daily_usage_legacy"
  ], "write");
  console.log("Migrated legacy single-router data (router='mtn').");
}

function localDate(now) {
  return new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

/**
 * Attempt to acquire an exclusive lock for polling a router.
 * Returns true if the lock was acquired, false if held by another active poller.
 */
export async function acquirePollerLock(router, lockedBy = os.hostname(), ttlSeconds = 120) {
  await ensureDbInitialized();
  const now = new Date();
  const nowIso = now.toISOString();
  const expiresAt = new Date(now.getTime() + ttlSeconds * 1000).toISOString();

  const res = await client.execute({
    sql: `INSERT INTO poller_locks (router, locked_by, locked_at, expires_at)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(router) DO UPDATE SET
            locked_by = excluded.locked_by,
            locked_at = excluded.locked_at,
            expires_at = excluded.expires_at
          WHERE expires_at < ? OR locked_by = ?`,
    args: [router, lockedBy, nowIso, expiresAt, nowIso, lockedBy]
  });

  return (res.rowsAffected || 0) > 0;
}

/**
 * Release a previously acquired poller lock.
 */
export async function releasePollerLock(router, lockedBy = os.hostname()) {
  await ensureDbInitialized();
  await client.execute({
    sql: "DELETE FROM poller_locks WHERE router = ? AND locked_by = ?",
    args: [router, lockedBy]
  });
}

/**
 * Record one poll reading for a router's counter, updating cumulative
 * totals. Handles counter resets (e.g. router reboot) by treating the
 * new value as a fresh delta rather than going negative.
 * Safeguarded against concurrent poll races and out-of-order readings.
 */
export async function recordReading(router, counter, downBytes, upBytes) {
  await ensureDbInitialized();
  const now = new Date();
  const ts = now.toISOString();
  const date = localDate(now);

  await client.execute({
    sql: "INSERT INTO raw_readings (ts, router, counter, down_bytes, up_bytes) VALUES (?, ?, ?, ?, ?)",
    args: [ts, router, counter, downBytes, upBytes]
  });

  const prevRes = await client.execute({
    sql: "SELECT * FROM last_counter WHERE router = ? AND counter = ?",
    args: [router, counter]
  });
  const prev = prevRes.rows[0];

  let downDelta = downBytes;
  let upDelta = upBytes;
  let resetDetected = false;

  if (prev) {
    const prevDown = Number(prev.down_bytes);
    const prevUp = Number(prev.up_bytes);

    if (downBytes >= prevDown && upBytes >= prevUp) {
      downDelta = downBytes - prevDown;
      upDelta = upBytes - prevUp;
    } else {
      // Counter dropped: distinguish between a genuine router reboot vs
      // concurrent poll race / out-of-order jitter.
      // A genuine reboot causes the counter to restart near zero (< 50% of previous reading,
      // or if previous was > 50MB and current dropped below 10MB).
      const isGenuineReboot =
        downBytes < prevDown * 0.5 ||
        (prevDown > 50 * 1024 * 1024 && downBytes < 10 * 1024 * 1024);

      if (isGenuineReboot) {
        resetDetected = true;
        downDelta = downBytes;
        upDelta = upBytes;
      } else {
        // Stale or slightly out-of-order reading from a concurrent poll;
        // do not book false delta and do not regress last_counter.
        downDelta = 0;
        upDelta = 0;
      }
    }
  }

  const batchQueries = [];
  if (downDelta > 0 || upDelta > 0) {
    batchQueries.push({
      sql: `INSERT INTO daily_usage (date, router, counter, down_bytes, up_bytes)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(date, router, counter) DO UPDATE SET
              down_bytes = daily_usage.down_bytes + excluded.down_bytes,
              up_bytes = daily_usage.up_bytes + excluded.up_bytes`,
      args: [date, router, counter, downDelta, upDelta]
    });
  }

  // Update last_counter if we moved forward or genuine reset
  if (!prev || downBytes >= Number(prev.down_bytes) || resetDetected) {
    batchQueries.push({
      sql: `INSERT INTO last_counter (router, counter, down_bytes, up_bytes, updated_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(router, counter) DO UPDATE SET
              down_bytes = excluded.down_bytes,
              up_bytes = excluded.up_bytes,
              updated_at = excluded.updated_at`,
      args: [router, counter, downBytes, upBytes, ts]
    });
  }

  if (batchQueries.length > 0) {
    await client.batch(batchQueries, "write");
  }

  return { downDelta, upDelta, resetDetected };
}

export async function getAllTimeByRouter() {
  await ensureDbInitialized();
  const res = await client.execute(
    "SELECT router, SUM(down_bytes) AS down_bytes, SUM(up_bytes) AS up_bytes FROM daily_usage GROUP BY router ORDER BY router"
  );
  return res.rows.map(r => ({
    router: r.router,
    down_bytes: Number(r.down_bytes),
    up_bytes: Number(r.up_bytes)
  }));
}

export async function getDailyTotals(days = 30) {
  await ensureDbInitialized();
  const res = await client.execute({
    sql: `SELECT date, router, SUM(down_bytes) AS down_bytes, SUM(up_bytes) AS up_bytes
          FROM daily_usage GROUP BY date, router ORDER BY date DESC LIMIT ?`,
    args: [days * 8]
  });
  return res.rows.map(r => ({
    date: r.date,
    router: r.router,
    down_bytes: Number(r.down_bytes),
    up_bytes: Number(r.up_bytes)
  }));
}

export async function getAllDailyTotals() {
  await ensureDbInitialized();
  const res = await client.execute(
    "SELECT date, router, SUM(down_bytes) AS down_bytes, SUM(up_bytes) AS up_bytes FROM daily_usage GROUP BY date, router ORDER BY date DESC"
  );
  return res.rows.map(r => ({
    date: r.date,
    router: r.router,
    down_bytes: Number(r.down_bytes),
    up_bytes: Number(r.up_bytes)
  }));
}

export async function getMonthlyTotals(months = 12) {
  await ensureDbInitialized();
  const res = await client.execute({
    sql: `SELECT substr(date, 1, 7) AS month, router, SUM(down_bytes) AS down_bytes, SUM(up_bytes) AS up_bytes
          FROM daily_usage GROUP BY month, router ORDER BY month DESC LIMIT ?`,
    args: [months * 8]
  });
  return res.rows.map(r => ({
    month: r.month,
    router: r.router,
    down_bytes: Number(r.down_bytes),
    up_bytes: Number(r.up_bytes)
  }));
}

export async function getYearlyTotals() {
  await ensureDbInitialized();
  const res = await client.execute(
    "SELECT substr(date, 1, 4) AS year, router, SUM(down_bytes) AS down_bytes, SUM(up_bytes) AS up_bytes FROM daily_usage GROUP BY year, router ORDER BY year DESC"
  );
  return res.rows.map(r => ({
    year: r.year,
    router: r.router,
    down_bytes: Number(r.down_bytes),
    up_bytes: Number(r.up_bytes)
  }));
}

export async function recordDevices(router, devices) {
  await ensureDbInitialized();
  const ts = new Date().toISOString();
  const queries = devices.map((d) => ({
    sql: "INSERT OR IGNORE INTO device_history (ts, router, mac, ip, hostname, interface, ssid, rssi) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    args: [
      ts,
      router,
      d.mac,
      d.ip,
      d.hostname || "",
      d.interface || "wlan",
      d.ssid || null,
      d.rssi != null ? parseInt(d.rssi, 10) : null
    ]
  }));
  if (queries.length > 0) {
    await client.batch(queries, "write");
  }
}

export async function getCurrentDevices() {
  await ensureDbInitialized();
  const res = await client.execute(`
    WITH latest_polls AS (
      SELECT router, MAX(ts) AS max_ts
      FROM device_history
      GROUP BY router
    )
    SELECT h.*
    FROM device_history h
    JOIN latest_polls p ON h.router = p.router AND h.ts = p.max_ts
    ORDER BY h.hostname ASC, h.ip ASC
  `);
  return res.rows.map(r => ({
    ...r,
    rssi: r.rssi != null ? Number(r.rssi) : null
  }));
}

export async function getDeviceRegistry() {
  await ensureDbInitialized();
  const res = await client.execute(`
    WITH device_aggregates AS (
      SELECT 
        mac,
        router,
        MIN(ts) AS first_seen,
        MAX(ts) AS last_seen,
        COUNT(*) AS poll_count
      FROM device_history
      GROUP BY mac, router
    )
    SELECT 
      a.*,
      h.hostname,
      h.ip,
      h.interface,
      h.ssid,
      h.rssi
    FROM device_aggregates a
    JOIN device_history h ON h.mac = a.mac AND h.router = a.router AND h.ts = a.last_seen
    ORDER BY a.last_seen DESC
  `);
  return res.rows.map(r => ({
    ...r,
    poll_count: Number(r.poll_count),
    rssi: r.rssi != null ? Number(r.rssi) : null
  }));
}

export async function getLastSeen() {
  await ensureDbInitialized();
  return client.execute("SELECT router, MAX(updated_at) AS updated_at FROM last_counter GROUP BY router");
}

export default client;
