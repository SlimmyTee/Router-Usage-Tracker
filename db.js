import { createClient } from "@libsql/client";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

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
  `CREATE INDEX IF NOT EXISTS idx_device_history_mac ON device_history(mac)`
];

let dbInitialized = false;
async function ensureDbInitialized() {
  if (dbInitialized) return;

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
    console.error("Database lazy initialization failed:", err);
    throw err;
  }
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
 * Record one poll reading for a router's counter, updating cumulative
 * totals. Handles counter resets (e.g. router reboot) by treating the
 * new value as a fresh delta rather than going negative.
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
      resetDetected = true;
    }
  }

  await client.batch([
    {
      sql: `INSERT INTO daily_usage (date, router, counter, down_bytes, up_bytes)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(date, router, counter) DO UPDATE SET
              down_bytes = daily_usage.down_bytes + excluded.down_bytes,
              up_bytes = daily_usage.up_bytes + excluded.up_bytes`,
      args: [date, router, counter, downDelta, upDelta]
    },
    {
      sql: `INSERT INTO last_counter (router, counter, down_bytes, up_bytes, updated_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(router, counter) DO UPDATE SET
              down_bytes = excluded.down_bytes,
              up_bytes = excluded.up_bytes,
              updated_at = excluded.updated_at`,
      args: [router, counter, downBytes, upBytes, ts]
    }
  ], "write");

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

export default client;
