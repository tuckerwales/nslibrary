import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import {
  BufferReader,
  buildSaveArchive,
  readSaveArchive,
  type SaveArchiveInput,
} from "@nslib/formats";

/** Packs a folder the way the Switch packs a mounted save. */
export async function archiveFolder(root: string): Promise<Buffer> {
  const inputs: SaveArchiveInput[] = [];
  const walk = async (dir: string) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      const rel = relative(root, path).split(sep).join("/");
      if (entry.isDirectory()) {
        inputs.push({ path: rel });
        await walk(path);
      } else if (entry.isFile()) {
        inputs.push({ path: rel, data: await readFile(path) });
      }
    }
  };
  await walk(root);
  return buildSaveArchive(inputs);
}

/** Unpacks a save archive into a folder, the way the Switch restores into a mounted save. */
export async function extractArchive(archive: Buffer, root: string): Promise<number> {
  const listing = await readSaveArchive(new BufferReader(archive));
  const base = resolve(root);
  for (const entry of listing.entries) {
    const target = resolve(base, ...entry.path.split("/"));
    // readSaveArchive already refuses "..", so this only guards against a future change there.
    if (!target.startsWith(base + sep)) throw new Error(`refusing to write outside ${root}`);
    if (entry.type === "dir") {
      await mkdir(target, { recursive: true });
    } else {
      await mkdir(resolve(target, ".."), { recursive: true });
      await writeFile(target, archive.subarray(entry.offset, entry.offset + entry.size));
    }
  }
  return listing.fileCount;
}
