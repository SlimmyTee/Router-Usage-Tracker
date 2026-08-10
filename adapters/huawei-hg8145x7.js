import { chromium } from "playwright";

/**
 * Adapter for the Huawei OptiXstar HG8145X7-10 (MTN GPON ONT).
 *
 * Logs into the web UI with Playwright, then reads the per-SSID byte
 * counters that /html/amp/wlaninfo/wlaninfo.asp embeds as JS arrays
 * (WlanInfo / PacketInfo) for both bands — no menu clicking needed.
 *
 * Direction: the router's TX is data sent to devices (download),
 * RX is data received from them (upload).
 */
export async function poll({ url, username, password }) {
  const headful = !!process.env.HEADFUL;
  const browser = await chromium.launch({ headless: !headful, slowMo: headful ? 150 : 0 });
  try {
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await context.newPage();

    await page.goto(url, { waitUntil: "domcontentloaded" });

    // The router redirects http://192.168.100.1 -> https://192.168.100.1:80/,
    // so give the login form time to appear before deciding there's a session.
    // The page markup also contains hidden change-password fields, so
    // target the login inputs by id.
    const userField = page.locator("#txt_Username");
    const formShown = await userField
      .waitFor({ state: "visible", timeout: 10000 })
      .then(() => true)
      .catch(() => false);
    if (formShown) {
      await userField.fill(username);
      await page.locator("#txt_Password").fill(password);
      await page.locator("#loginbutton").click();
      await page.waitForLoadState("domcontentloaded");
    }

    // Base off wherever the router's redirects actually landed us.
    const base = new URL(page.url()).origin;
    await page.goto(`${base}/html/amp/wlaninfo/wlaninfo.asp`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(
      () => typeof PacketInfo !== "undefined" && typeof WlanInfo !== "undefined",
      { timeout: 15000 }
    );

    // stPacketInfo(domain, totalBytesSent, totalPacketsSent,
    //              totalBytesReceived, totalPacketsReceived)
    const totals = await page.evaluate(() => {
      // ath0..ath(ssidStart5G-1) are 2.4GHz SSIDs, the rest 5GHz —
      // same split the page itself uses to build WlanInfo5G.
      const start5g = typeof ssidStart5G !== "undefined" ? ssidStart5G : 4;
      const bands = {
        "2.4GHz": { rx: 0, tx: 0, ssids: [] },
        "5GHz": { rx: 0, tx: 0, ssids: [] },
      };
      for (let i = 0; i < WlanInfo.length; i++) {
        const w = WlanInfo[i];
        const p = PacketInfo[i];
        if (!w || !p) continue;
        const athIdx = parseInt(String(w.name).replace(/\D/g, ""), 10);
        const band = athIdx >= start5g ? "5GHz" : "2.4GHz";
        bands[band].rx += parseInt(p.totalBytesReceived, 10) || 0;
        bands[band].tx += parseInt(p.totalBytesSent, 10) || 0;
        bands[band].ssids.push(w.ssid);
      }
      return bands;
    });

    return Object.entries(totals).map(([band, t]) => ({
      counter: band,
      downBytes: t.tx,
      upBytes: t.rx,
      note: t.ssids.join(", "),
    }));
  } finally {
    await browser.close();
  }
}
