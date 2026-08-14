import { createHash, randomBytes } from "node:crypto";

/**
 * Adapter for Airtel CPE routers running the "Highwmg" Vue firmware
 * (TCL/Wingtech-style JSON API at /cgi-bin/http.cgi).
 *
 * Auth flow (reverse-engineered from the UI's login.js):
 *   1. POST {cmd: 232}            -> { token }
 *   2. POST {cmd: 100, username, passwd: sha256(token + password),
 *            sessionId: <random 64 hex>}   -> { sessionId }
 *   3. Authenticated calls pass that sessionId in the JSON body.
 *
 * Usage counters come from FLOW_INFO (cmd 18). The exact field names
 * vary between firmware builds, so parsing tries known candidates and
 * fails loudly with the raw response so the mapping can be extended.
 */

const CMD = { GET_TOKEN: 232, LOGIN: 100, LOGOUT: 101, FLOW_INFO: 18, FLOW_MONITORING: 203 };

const sha256 = (s) => createHash("sha256").update(s).digest("hex");

async function post(base, json) {
  const res = await fetch(`${base}/cgi-bin/http.cgi`, {
    method: "POST",
    body: JSON.stringify({ language: "en", sessionId: "", ...json }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${base}/cgi-bin/http.cgi`);
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Non-JSON response for cmd ${json.cmd}: ${text.slice(0, 300)}`);
  }
}

// Candidate field pairs seen across this firmware family, in order of
// preference: cumulative totals first, then current-session counters.
const FIELD_CANDIDATES = [
  // Modem-perspective totals since boot: rxBytes = received from the
  // internet (download). Confirmed on Airtel Nigeria "Highwmg" firmware.
  { down: "rxBytes", up: "txBytes", counter: "wan" },
  { down: "total_recv", up: "total_send", counter: "wan" },
  { down: "total_rx", up: "total_tx", counter: "wan" },
  { down: "all_recv", up: "all_send", counter: "wan" },
  { down: "curr_recv", up: "curr_send", counter: "wan-session" },
  { down: "recv_bytes", up: "send_bytes", counter: "wan-session" },
  { down: "download", up: "upload", counter: "wan-session" },
];

function pickCounters(flow) {
  const results = [];
  for (const c of FIELD_CANDIDATES) {
    if (flow[c.down] != null && flow[c.up] != null) {
      results.push({
        counter: c.counter,
        downBytes: parseInt(flow[c.down], 10) || 0,
        upBytes: parseInt(flow[c.up], 10) || 0,
      });
      break;
    }
  }
  if (!results.length) {
    throw new Error(
      "FLOW_INFO response had no recognized byte-counter fields. Raw response:\n" +
        JSON.stringify(flow, null, 2)
    );
  }
  return results;
}

export async function poll({ url, username, password }) {
  const base = url.replace(/\/$/, "");

  const tok = await post(base, { cmd: CMD.GET_TOKEN, method: "GET" });
  if (!tok.token) throw new Error(`No token in cmd 232 response: ${JSON.stringify(tok)}`);

  const login = await post(base, {
    cmd: CMD.LOGIN,
    method: "POST",
    sessionId: randomBytes(32).toString("hex"),
    username,
    passwd: sha256(tok.token + password),
    isAutoUpgrade: "0",
    subcmd: 0,
  });
  if (!login.success || login.login_fail === "fail" || login.login_fail2 === "fail") {
    throw new Error(`Airtel login failed: ${JSON.stringify(login)}`);
  }
  const sessionId = login.sessionId;

  try {
    const flow = await post(base, { cmd: CMD.FLOW_INFO, method: "GET", sessionId });
    if (process.env.DEBUG_AIRTEL) {
      console.log("FLOW_INFO raw:", JSON.stringify(flow, null, 2));
    }
    const readings = pickCounters(flow);

    let devices = [];
    try {
      const dhcpRes = await post(base, { cmd: 223, method: "GET", sessionId });
      const wifi24Res = await post(base, { cmd: 224, method: "GET", sessionId });
      const wifi5Res = await post(base, { cmd: 225, method: "GET", sessionId });

      const dhcpList = dhcpRes.dhcp_list_info || [];
      const wifi24List = wifi24Res.wlan24g_wifi_info || [];
      const wifi5List = wifi5Res.wlan5g_wifi_info || [];

      const wifiMap = new Map();
      for (const item of wifi24List) {
        if (item.mac) {
          wifiMap.set(item.mac.toLowerCase(), { band: "2.4GHz", ssid: item.ssid, rssi: item.rssi });
        }
      }
      for (const item of wifi5List) {
        if (item.mac) {
          wifiMap.set(item.mac.toLowerCase(), { band: "5GHz", ssid: item.ssid, rssi: item.rssi });
        }
      }

      for (const client of dhcpList) {
        if (!client.mac) continue;
        const macLower = client.mac.toLowerCase();
        const wifiDetails = wifiMap.get(macLower);

        let intf = client.interface || "lan";
        let ssid = null;
        let rssi = null;

        if (wifiDetails) {
          intf = wifiDetails.band;
          ssid = wifiDetails.ssid || null;
          rssi = wifiDetails.rssi != null && wifiDetails.rssi !== "" ? parseInt(wifiDetails.rssi, 10) : null;
        } else if (intf === "wlan") {
          intf = "Wi-Fi";
        } else if (intf === "lan") {
          intf = "Wired";
        }

        devices.push({
          mac: client.mac,
          ip: client.ip || "",
          hostname: client.hostname || "",
          interface: intf,
          ssid,
          rssi
        });
      }
    } catch (devicesErr) {
      console.warn("Failed to poll connected devices: " + (devicesErr.message || devicesErr));
    }

    return { readings, devices };
  } finally {
    // Best-effort logout so we don't hold one of the router's sessions.
    await post(base, {
      cmd: CMD.LOGOUT,
      method: "POST",
      sessionId,
      token: login.token,
    }).catch(() => {});
  }
}
