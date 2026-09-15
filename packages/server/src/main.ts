import { loadConfig } from "./config";
import { createServer } from "./server";

const config = loadConfig();
const server = await createServer(config);
await server.app.listen({ host: config.host, port: config.port });
await server.start();
if (server.discovery) {
  server.app.log.info(`UDP discovery listening on port ${server.discovery.port}`);
}

// Whoever reaches a fresh server first would otherwise own it, so setup needs a token that only
// someone who can read this log has.
if (server.auth.isSetupRequired() && config.setupToken) {
  server.app.log.info(
    config.setupTokenGenerated
      ? `\n\n  Setup token: ${config.setupToken}\n\n  Enter it when you create the admin account. It changes on every restart.\n  Set NSLIB_SETUP_TOKEN to choose your own.\n`
      : "Setup token required to create the admin account (NSLIB_SETUP_TOKEN).",
  );
}

if (!config.webDir) {
  server.app.log.info(
    "No built web UI found; serving the API only. Run `pnpm --filter @nslib/web build`.",
  );
}

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  server.app.log.info(`Received ${signal}, shutting down`);
  await server.close();
  process.exit(0);
}
process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
