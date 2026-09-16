import { resolve } from "node:path";
import { generateDemoLibrary } from "./generate";

const args = process.argv.slice(2).filter((arg) => arg !== "--");
const libraryDir = resolve(args[0] ?? "data/demo-library");
const keysPath = resolve(args[1] ?? "data/keys/prod.keys");
const result = await generateDemoLibrary({ libraryDir, keysPath });
process.stdout.write(
  `Wrote ${result.files.length} demo files to ${result.libraryDir}\nKeys: ${result.keysPath}\n`,
);
