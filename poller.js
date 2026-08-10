import { loadRouters } from "./config.js";
import { recordReading } from "./db.js";

const ADAPTERS = {
  "huawei-hg8145x7": () => import("./adapters/huawei-hg8145x7.js"),
  "airtel-httpcgi": () => import("./adapters/airtel-httpcgi.js"),
  "zte-zwrt": () => import("./adapters/zte-zwrt.js"),
};

function log(...args) {
  console.log(new Date().toISOString(), "-", ...args);
}

const only = process.argv[2]; // optional: poll a single router by key

let failed = false;
for (const router of loadRouters()) {
  if (only && router.key !== only) continue;

  const label = router.name === router.key ? router.key : `${router.name} [${router.key}]`;

  if (router.missing.length) {
    console.error(`Skipping "${label}": missing ${router.missing.join(", ")} in .env`);
    failed = true;
    continue;
  }

  const load = ADAPTERS[router.type];
  if (!load) {
    console.error(`Unknown router type "${router.type}" for "${label}". Known: ${Object.keys(ADAPTERS).join(", ")}`);
    failed = true;
    continue;
  }

  try {
    const { poll } = await load();
    const readings = await poll(router);
    for (const { counter, downBytes, upBytes, note } of readings) {
      const { downDelta, upDelta, resetDetected } = recordReading(
        router.key,
        counter,
        downBytes,
        upBytes
      );
      log(
        `${label}/${counter}${note ? ` (${note})` : ""}: raw down=${downBytes} up=${upBytes} | delta down=${downDelta} up=${upDelta}` +
          (resetDetected ? " | RESET DETECTED (counter restarted: reboot or monthly clear)" : "")
      );
    }
  } catch (err) {
    console.error(`Poll failed for "${label}":`, err.message || err);
    failed = true;
  }
}

log(failed ? "Poll finished with errors." : "Poll complete.");
if (failed) process.exitCode = 1;
