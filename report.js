import {
  getAllTimeByRouter,
  getDailyTotals,
  getMonthlyTotals,
  getYearlyTotals,
} from "./db.js";
import { loadRouters } from "./config.js";

// Map stored router keys to display names from .env; routers no longer
// configured fall back to their stored key.
const displayName = new Map(loadRouters().map((r) => [r.key, r.name]));
const nameOf = (key) => displayName.get(key) || key;

function gb(bytes) {
  return (bytes / 1024 ** 3).toFixed(3) + " GB";
}

// Pivot [{<bucket>, router, down_bytes, up_bytes}] into one line per
// bucket with a per-router breakdown and a sum.
function printBuckets(rows, bucketKey) {
  const buckets = new Map();
  for (const row of rows) {
    if (!buckets.has(row[bucketKey])) buckets.set(row[bucketKey], []);
    buckets.get(row[bucketKey]).push(row);
  }
  for (const [bucket, routers] of buckets) {
    const down = routers.reduce((s, r) => s + r.down_bytes, 0);
    const up = routers.reduce((s, r) => s + r.up_bytes, 0);
    const perRouter = routers
      .map((r) => `${nameOf(r.router)} ${gb(r.down_bytes + r.up_bytes)}`)
      .join(", ");
    console.log(
      `${bucket}  down ${gb(down).padEnd(12)} up ${gb(up).padEnd(12)} total ${gb(down + up).padEnd(12)} [${perRouter}]`
    );
  }
}

const allTime = await getAllTimeByRouter();
console.log("=== All-time (since tracker started) ===");
if (!allTime.length) {
  console.log("No data yet — run `npm run poll` at least once.");
} else {
  let down = 0;
  let up = 0;
  const width = Math.max(10, ...allTime.map((r) => nameOf(r.router).length + 1));
  for (const row of allTime) {
    down += row.down_bytes;
    up += row.up_bytes;
    console.log(
      `${nameOf(row.router).padEnd(width)} down ${gb(row.down_bytes).padEnd(12)} up ${gb(row.up_bytes).padEnd(12)} total ${gb(row.down_bytes + row.up_bytes)}`
    );
  }
  console.log(
    `${"ALL".padEnd(width)} down ${gb(down).padEnd(12)} up ${gb(up).padEnd(12)} total ${gb(down + up)}`
  );
}

console.log("\n=== Last 30 days ===");
printBuckets(await getDailyTotals(30), "date");

console.log("\n=== Monthly ===");
printBuckets(await getMonthlyTotals(12), "month");

console.log("\n=== Yearly ===");
printBuckets(await getYearlyTotals(), "year");
