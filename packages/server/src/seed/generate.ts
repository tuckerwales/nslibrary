/**
 * Writes a synthetic demo library (no copyrighted data) plus a matching fake prod.keys so
 * the UI has names, flags, homebrew, and problem rows to show.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  buildNro,
  buildPfs0,
  buildTicket,
  buildTitleNsp,
  CnmtType,
  deterministicBytes,
  formatProdKeys,
  generateFakeKeyset,
  rightsIdFor,
} from "@nslib/fixtures";

function placeholderNsp(seed: string, tickets: string[] = []): Buffer {
  const ncaId = (part: string) => deterministicBytes(`${seed}:${part}:id`, 16).toString("hex");
  const entries = [
    { name: `${ncaId("meta")}.cnmt.nca`, data: deterministicBytes(`${seed}:meta`, 0x200) },
    { name: `${ncaId("program")}.nca`, data: deterministicBytes(`${seed}:program`, 0x800) },
  ];
  for (const titleId of tickets) {
    const rightsId = rightsIdFor(titleId, 0x0b);
    entries.push(
      {
        name: `${rightsId.toLowerCase()}.tik`,
        data: buildTicket({ rightsId, keyGeneration: 0x0b }),
      },
      { name: `${rightsId.toLowerCase()}.cert`, data: deterministicBytes(`${seed}:cert`, 0x700) },
    );
  }
  return buildPfs0(entries);
}

export const DEMO_TITLES = {
  harborWatch: "0100A11CE0000000",
  harborWatchUpdate: "0100A11CE0000800",
  harborWatchDlc: "0100A11CE0001001",
  redwood: "0100B22D00000000",
  nightCircuit: "0100C33E00000000",
  nightCircuitUpdate: "0100C33E00000800",
  driftwoodDlc: "0100D44F00001001",
} as const;

export interface GenerateDemoLibraryResult {
  libraryDir: string;
  keysPath: string;
  files: string[];
}

export async function generateDemoLibrary(options: {
  libraryDir: string;
  keysPath: string;
}): Promise<GenerateDemoLibraryResult> {
  const keys = generateFakeKeyset();
  await mkdir(options.libraryDir, { recursive: true });
  await mkdir(dirname(options.keysPath), { recursive: true });
  await writeFile(options.keysPath, formatProdKeys(keys), { encoding: "utf8", mode: 0o600 });

  const files: Array<{ relPath: string; data: Buffer }> = [
    {
      relPath: `Harbor Watch [${DEMO_TITLES.harborWatch}][v0].nsp`,
      data: buildTitleNsp({
        titleId: DEMO_TITLES.harborWatch,
        keys,
        name: "Harbor Watch",
        publisher: "Northshore",
        icon: null,
      }).nsp,
    },
    {
      relPath: `updates/Harbor Watch [${DEMO_TITLES.harborWatchUpdate}][v65536].nsp`,
      data: buildTitleNsp({
        titleId: DEMO_TITLES.harborWatchUpdate,
        version: 65536,
        type: CnmtType.Patch,
        keys,
        name: "Harbor Watch",
        publisher: "Northshore",
        icon: null,
      }).nsp,
    },
    {
      relPath: `updates/Harbor Watch [${DEMO_TITLES.harborWatchUpdate}][v196608].nsp`,
      data: buildTitleNsp({
        titleId: DEMO_TITLES.harborWatchUpdate,
        version: 196608,
        type: CnmtType.Patch,
        keys,
        name: "Harbor Watch",
        publisher: "Northshore",
        icon: null,
      }).nsp,
    },
    {
      relPath: `dlc/Harbor Watch - Tide Charts [${DEMO_TITLES.harborWatchDlc}][v0].nsp`,
      data: buildTitleNsp({
        titleId: DEMO_TITLES.harborWatchDlc,
        type: CnmtType.AddOnContent,
        applicationId: DEMO_TITLES.harborWatch,
        keys,
        name: "Tide Charts",
        publisher: "Northshore",
        icon: null,
      }).nsp,
    },
    {
      relPath: `backups/Harbor Watch [${DEMO_TITLES.harborWatch}][v0].nsz`,
      data: buildTitleNsp({
        titleId: DEMO_TITLES.harborWatch,
        keys,
        name: "Harbor Watch",
        publisher: "Northshore",
        icon: null,
      }).nsp,
    },
    {
      relPath: `Redwood Station [${DEMO_TITLES.redwood}][v0].nsp`,
      data: buildTitleNsp({
        titleId: DEMO_TITLES.redwood,
        keys,
        name: "Redwood Station",
        publisher: "Pine & Iron",
        icon: null,
      }).nsp,
    },
    {
      relPath: `Night Circuit [${DEMO_TITLES.nightCircuitUpdate}][v65536].nsp`,
      data: buildTitleNsp({
        titleId: DEMO_TITLES.nightCircuitUpdate,
        version: 65536,
        type: CnmtType.Patch,
        keys,
        name: "Night Circuit",
        publisher: "Volt & Vale",
        icon: null,
      }).nsp,
    },
    {
      relPath: `dlc/Driftwood Pack [${DEMO_TITLES.driftwoodDlc}][v0].nsp`,
      data: placeholderNsp("driftwood", [DEMO_TITLES.driftwoodDlc]),
    },
    {
      relPath: "homebrew/Scanline.nro",
      data: buildNro({
        name: "Scanline",
        publisher: "Dockside",
        displayVersion: "0.4.1",
        icon: null,
      }),
    },
    {
      relPath: "problems/backup.nsp",
      data: placeholderNsp("unidentified"),
    },
    {
      relPath: "problems/broken.xci",
      data: deterministicBytes("broken-xci", 0x400),
    },
  ];

  const written: string[] = [];
  for (const file of files) {
    const abs = join(options.libraryDir, file.relPath);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, file.data);
    written.push(file.relPath);
  }

  return { libraryDir: options.libraryDir, keysPath: options.keysPath, files: written };
}
