import { loadConfig } from "./config";
import { createServer } from "./server";

const config = loadConfig();
const server = await createServer(config);
await server.app.listen({ host: config.host, port: config.port });
await server.start();

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
