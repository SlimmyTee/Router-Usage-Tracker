import { createHash } from "node:crypto";

/**
 * Adapter for ZTE CPEs running the OpenWrt/zwrt firmware with a ubus
 * JSON-RPC API at /ubus/ (e.g. ZTE MC8830 5G CPE, sold by MTN).
 *
 * Auth flow (reverse-engineered from the UI's service_rpc.js):
 *   1. zwrt_web web_login_info      -> { zte_web_sault }
 *   2. zwrt_web web_login {password: SHA256(SHA256(pw) + sault)}
 *      (uppercase hex)              -> { ubus_rpc_session }
 *   3. Authenticated calls pass the session as ubus params[0].
 *
 * Login takes no username — only the password is checked.
 *
 * Counters: zwrt_data get_wwandst type=2 returns this-month WAN totals
 * (month_rx_bytes = download). They reset on the router's monthly
 * clear-day, which the tracker's reset-safe delta logic absorbs.
 */

const NULL_SID = "00000000000000000000000000000000";

const sha256Upper = (s) => createHash("sha256").update(s).digest("hex").toUpperCase();

export async function poll({ url, password }) {
  const base = url.replace(/\/$/, "");
  let id = 1;

  async function call(sid, service, method, args) {
    const res = await fetch(`${base}/ubus/?t=${Date.now()}`, {
      method: "POST",
      // The ubus endpoint rejects requests without browser-like
      // Origin/Referer headers.
      headers: {
        "Content-Type": "text/plain;charset=UTF-8",
        Origin: base,
        Referer: `${base}/`,
      },
      body: JSON.stringify([
        { jsonrpc: "2.0", id: id++, method: "call", params: [sid, service, method, args] },
      ]),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${base}/ubus/`);
    const text = await res.text();
    let parsed;
    try {
      parsed = JSON.parse(text)[0];
    } catch {
      throw new Error(`Non-JSON ubus response for ${service}.${method}: ${text.slice(0, 200)}`);
    }
    const result = parsed?.result;
    if (!Array.isArray(result) || result[0] !== 0) {
      throw new Error(`ubus ${service}.${method} failed: ${JSON.stringify(parsed).slice(0, 300)}`);
    }
    return result[1] ?? {};
  }

  const info = await call(NULL_SID, "zwrt_web", "web_login_info", {});
  if (!info.zte_web_sault) {
    throw new Error(`No zte_web_sault in web_login_info response: ${JSON.stringify(info)}`);
  }

  const login = await call(NULL_SID, "zwrt_web", "web_login", {
    password: sha256Upper(sha256Upper(password) + info.zte_web_sault),
  });
  if (String(login.result) !== "0" || !login.ubus_rpc_session) {
    throw new Error(`ZTE login failed: ${JSON.stringify(login)}`);
  }
  const session = login.ubus_rpc_session;

  try {
    const month = await call(session, "zwrt_data", "get_wwandst", {
      source_module: "web",
      cid: 1,
      type: 2,
    });
    if (month.month_rx_bytes == null || month.month_tx_bytes == null) {
      throw new Error(`No month_rx/tx_bytes in get_wwandst response: ${JSON.stringify(month)}`);
    }
    return [
      {
        counter: "wan",
        downBytes: parseInt(month.month_rx_bytes, 10) || 0,
        upBytes: parseInt(month.month_tx_bytes, 10) || 0,
      },
    ];
  } finally {
    await call(session, "zwrt_web", "web_logout", {}).catch(() => {});
  }
}
