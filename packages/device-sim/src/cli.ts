#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { DeviceClient } from "./client";
import { archiveFolder, extractArchive } from "./save-folder";

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
    app: { type: "string" },
    type: { type: "string", default: "account" },
    user: { type: "string" },
    "user-name": { type: "string" },
    dir: { type: "string" },
    id: { type: "string" },
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
    case "saves":
      console.log(JSON.stringify(await client.listSaves({ app: values.app }), null, 2));
      break;
    case "backup": {
      if (!values.app || !values.dir) throw new Error("backup requires --app and --dir");
      const type = values.type === "device" ? "device" : "account";
      const archive = await archiveFolder(values.dir);
      const result = await client.uploadSave(archive, {
        app: values.app.toUpperCase(),
        type,
        user: type === "account" ? (values.user ?? "00000000000000000000000000000001") : undefined,
        userName: values["user-name"],
      });
      console.log(JSON.stringify(result, null, 2));
      break;
    }
    case "restore": {
      if (!values.id || !values.dir) throw new Error("restore requires --id and --dir");
      const response = await client.downloadSave(Number(values.id));
      if (!response.ok) throw new Error(`download failed: HTTP ${response.status}`);
      const files = await extractArchive(Buffer.from(await response.arrayBuffer()), values.dir);
      console.log(`Restored ${files} files into ${values.dir}`);
      break;
    }
    default:
      console.error(
        "Usage: nslib-sim <pair|hello|catalog|events|saves|backup|restore> --url --token [--code]\n" +
          "  saves   [--app ID]\n" +
          "  backup  --app ID --dir FOLDER [--type account|device] [--user UID] [--user-name NAME]\n" +
          "  restore --id BACKUP --dir FOLDER",
      );
      process.exitCode = 1;
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
}
