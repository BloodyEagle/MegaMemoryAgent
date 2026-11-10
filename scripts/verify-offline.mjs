import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { syncBuiltinESMExports } from "node:module";

const loopback = (host) => ["localhost", "127.0.0.1", "::1", "[::1]"].includes(String(host).toLowerCase());
const blocked = () => { throw new Error("VERIFY_EXTERNAL_NETWORK_FORBIDDEN"); };
const originalFetch = globalThis.fetch;
globalThis.fetch = (input, options) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  if (url.protocol !== "http:" || !loopback(url.hostname)) return Promise.reject(new Error("VERIFY_EXTERNAL_NETWORK_FORBIDDEN"));
  return originalFetch(input, options);
};
for (const method of ["request", "get"]) {
  const original = http[method];
  http[method] = (input, ...args) => {
    const host = typeof input === "string" || input instanceof URL ? new URL(input).hostname : input.hostname || input.host || "localhost";
    if (!loopback(host)) return blocked();
    return original(input, ...args);
  };
  https[method] = blocked;
}
const originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const options = Array.isArray(args[0]) ? args[0][0] : args[0];
  if (typeof options === "object") {
    if (!options.path && !loopback(options.host || "localhost")) return blocked();
  } else if (typeof options === "number" && typeof args[1] === "string" && !loopback(args[1])) return blocked();
  else if (typeof options !== "number") return blocked();
  return originalConnect.apply(this, args);
};
tls.connect = blocked;
syncBuiltinESMExports();
