import http from "node:http";
import { execFile } from "node:child_process";
import handler from "./api/index.js";

const PORT = parseInt(process.env.PORT || "8787", 10);
const server = http.createServer(handler);

server.listen(PORT, () => {
  const url = `http://localhost:${PORT}`;
  console.log(`Dashboard running at ${url}`);
  if (process.platform === "darwin" && !process.env.NO_OPEN) {
    execFile("open", [url], () => {});
  }
});
