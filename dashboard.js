import http from "node:http";
import { execFile } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import db, { getAllTimeByRouter, getDailyTotals, getMonthlyTotals, getYearlyTotals } from "./db.js";
import { loadRouters } from "./config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || "8787", 10);

const lastSeenStmt = db.prepare(
  `SELECT router, MAX(updated_at) AS updated_at FROM last_counter GROUP BY router`
);

function apiData() {
  const routers = loadRouters().map((r, i) => ({ key: r.key, name: r.name, slot: i }));
  return {
    generatedAt: new Date().toISOString(),
    routers,
    allTime: getAllTimeByRouter(),
    daily: getDailyTotals(30),
    monthly: getMonthlyTotals(12),
    yearly: getYearlyTotals(),
    lastSeen: lastSeenStmt.all(),
  };
}

const html = fs.readFileSync(path.join(__dirname, "dashboard.html"));

const server = http.createServer((req, res) => {
  if (req.url?.startsWith("/api/data")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(apiData()));
  } else if (req.url === "/" || req.url?.startsWith("/index")) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
  } else {
    res.writeHead(404);
    res.end("Not found");
  }
});

server.listen(PORT, () => {
  const url = `http://localhost:${PORT}`;
  console.log(`Dashboard running at ${url}`);
  if (process.platform === "darwin" && !process.env.NO_OPEN) {
    execFile("open", [url], () => {});
  }
});
