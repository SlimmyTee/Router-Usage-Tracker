import "dotenv/config";

/**
 * Routers are declared in .env:
 *
 *   ROUTERS=mtn,airtel
 *
 *   MTN_TYPE=huawei-hg8145x7
 *   MTN_URL=http://192.168.100.1
 *   MTN_USERNAME=root        # some router types don't use one
 *   MTN_PASSWORD=...
 *   MTN_NAME=MTN Fibre       # optional display name for reports/logs
 *
 * The prefix is the router key upper-cased (non-alphanumerics -> _).
 * The key is what's stored in the database; NAME is only presentation,
 * so it can be changed at any time without orphaning data.
 */
export function loadRouters() {
  const names = (process.env.ROUTERS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!names.length) {
    throw new Error("Set ROUTERS in .env, e.g. ROUTERS=mtn,airtel");
  }

  return names.map((name) => {
    const prefix = name.toUpperCase().replace(/[^A-Z0-9]/g, "_");
    const get = (key) => process.env[`${prefix}_${key}`];
    const cfg = {
      key: name,
      name: get("NAME") || name,
      type: get("TYPE"),
      url: get("URL"),
      username: get("USERNAME"),
      password: get("PASSWORD"),
    };
    // Report missing values per router instead of throwing, so one
    // unconfigured router doesn't block polling the others.
    // USERNAME is optional: some router types authenticate with a
    // password only; adapters that need it fail loudly at login.
    cfg.missing = ["type", "url", "password"]
      .filter((key) => !cfg[key])
      .map((key) => `${prefix}_${key.toUpperCase()}`);
    return cfg;
  });
}
