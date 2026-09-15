#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { DeviceClient } from "./client";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    url: { type: "string", default: "http://127.0.0.1:8465" },
    token: { type: "string" },
    code: { type: "string" },
    name: { type: "string", default: "device-sim" },
    uuid: { type: "string" },
    wait: { type: "string", default: "25" },
    cursor: { type: "string" },
    since: { type: "string" },
  },
});

const command = positionals[0];
const client = new DeviceClient(values.url ?? "http://127.0.0.1:8465", values.token);

try {
  switch (command) {
    case "pair": {
      if (!values.code) throw new Error("pair requires --code");
      const result = await client.pair({
        code: values.code,
        deviceUuid: values.uuid ?? randomUUID(),
        name: values.name ?? "device-sim",
        fw: "19.0.1",
        amsVersion: "1.8.0",
        appVersion: "0.1.0",
      });
      console.log(JSON.stringify(result, null, 2));
      break;
    }
    case "hello":
      console.log(JSON.stringify(await client.hello(), null, 2));
      break;
    case "catalog":
      console.log(
        JSON.stringify(
          await client.catalog({
            since: values.since ? Number(values.since) : undefined,
          }),
          null,
          2,
        ),
      );
      break;
    case "events":
      console.log(
        JSON.stringify(
          await client.events({
            cursor: values.cursor,
            wait: values.wait ? Number(values.wait) : undefined,
          }),
          null,
          2,
        ),
      );
      break;
    default:
      console.error("Usage: nslib-sim <pair|hello|catalog|events> --url --token [--code]");
      process.exitCode = 1;
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
}
