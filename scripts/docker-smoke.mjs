#!/usr/bin/env node
/** Hit a running NSLibrary container: health, setup, pairing, hello, catalog. */
const base = process.env.NSLIB_SMOKE_URL ?? "http://127.0.0.1:8465";

async function waitForHealth(timeoutMs = 90_000) {
  const start = Date.now();
  let last = "";
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${base}/api/health`);
      if (res.ok) {
        const body = await res.json();
        if (body.ok) return;
      }
      last = `HTTP ${res.status}`;
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`Timed out waiting for ${base}/api/health (${last})`);
}

async function json(method, path, { cookie, body, token } = {}) {
  const headers = {};
  if (cookie) headers.cookie = cookie;
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(data)}`);
  }
  return { res, data, cookie: res.headers.get("set-cookie") };
}

await waitForHealth();
const setup = await json("POST", "/api/v1/auth/setup", {
  body: { username: "smoke", password: "correct horse" },
});
const cookie = setup.cookie?.split(";")[0];
if (!cookie) throw new Error("setup did not set a session cookie");

const apps = await json("GET", "/api/v1/apps", { cookie });
if (!Array.isArray(apps.data) || apps.data.length === 0) {
  throw new Error("expected the demo library to list at least one title");
}

const code = await json("POST", "/api/v1/devices/pairing-code", { cookie });
const pair = await json("POST", "/api/device/v1/pair", {
  body: {
    code: code.data.code,
    deviceUuid: "3f2b8c1e-9a4d-4e7b-8c21-5d6f0a1b2c3d",
    name: "smoke-sim",
    fw: "19.0.1",
    amsVersion: "1.8.0",
    appVersion: "0.1.0",
  },
});
const token = pair.data.token;
if (typeof token !== "string" || token.length !== 43) {
  throw new Error("pair did not return a device token");
}

const hello = await json("GET", "/api/device/v1/hello", { token });
if (hello.data.proto !== 1) throw new Error(`unexpected proto ${hello.data.proto}`);

const catalog = await json("GET", "/api/device/v1/catalog", { token });
if (!catalog.data.full || !Array.isArray(catalog.data.apps) || catalog.data.apps.length === 0) {
  throw new Error("catalog was empty");
}

console.log(
  `ok  health setup pair hello catalog (${catalog.data.apps.length} apps, ${apps.data.length} web titles)`,
);
