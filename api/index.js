import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import { execFile } from "node:child_process";
import db, {
  getAllTimeByRouter,
  getDailyTotals,
  getMonthlyTotals,
  getYearlyTotals,
  getCurrentDevices,
  getDeviceRegistry,
  getAllDailyTotals
} from "../db.js";
import { loadRouters } from "../config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(__dirname, "../dashboard.html"));

async function apiData() {
  const routers = loadRouters().map((r, i) => ({ key: r.key, name: r.name, slot: i }));
  const [allTime, daily, monthly, yearly, lastSeenRes, currentDevices, deviceRegistry, allDaily] = await Promise.all([
    getAllTimeByRouter(),
    getDailyTotals(30),
    getMonthlyTotals(12),
    getYearlyTotals(),
    db.execute(`SELECT router, MAX(updated_at) AS updated_at FROM last_counter GROUP BY router`),
    getCurrentDevices(),
    getDeviceRegistry(),
    getAllDailyTotals(),
  ]);

  return {
    generatedAt: new Date().toISOString(),
    routers,
    allTime,
    daily,
    monthly,
    yearly,
    lastSeen: lastSeenRes.rows,
    currentDevices,
    deviceRegistry,
    allDaily,
  };
}

export default async function handler(req, res) {
  const urlObj = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const pathname = urlObj.pathname;

  if (pathname === "/api/data") {
    try {
      const data = await apiData();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(data));
    } catch (err) {
      console.error("Failed to load api data:", err);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
  } else if (pathname === "/api/poll") {
    const routerKey = urlObj.searchParams.get("router");

    const pollerPath = path.join(__dirname, "../poller.js");
    const args = [pollerPath];
    if (routerKey) {
      args.push(routerKey);
    }

    execFile(process.argv[0], args, (error, stdout, stderr) => {
      if (error) {
        console.error("Manual poll failed:", error);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: error.message }));
      } else {
        console.log("Manual poll finished successfully.");
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true }));
      }
    });
  } else if (pathname === "/" || pathname === "/api/index.js" || pathname.startsWith("/index")) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
  } else {
    res.writeHead(404);
    res.end("Not found");
  }
}
