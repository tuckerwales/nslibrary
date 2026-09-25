/**
 * Inspection of a library file. Tickets and filenames work without keys; CNMT, names, and
 * icons from control NCAs need the user's `prod.keys`.
 */
import {
  BufferReader,
  type CnmtContentRecord,
  type CnmtInfo,
  decompressNczToBuffer,
  decryptNcaHeader,
  decryptTitleKey,
  FormatError,
  type Keyset,
  type LibraryFileFormat,
  listContainerEntries,
  MissingKeyError,
  NCA_HEADER_SIZE,
  type PartitionEntry,
  parseNro,
  parseTicket,
  type RandomAccessReader,
  readCnmtFromMetaNca,
  readControlNca,
  readExact,
  SliceReader,
  type TicketInfo,
} from "@nslib/formats";
import {
  type ApplicationIdSource,
  applicationIdForPatch,
  type ContentMetaType,
  guessApplicationIdForAddon,
  inferTypeFromTitleId,
  parseTitleFilename,
} from "@nslib/shared";

/** Bump when inspection output changes so existing files are re-parsed on the next scan. */
export const PARSER_VERSION = 2;

const MAX_TICKET_SIZE = 0x1000;
const MAX_ICON_SIZE = 0x80000;
const MAX_PARSEABLE_NCA = 32 * 1024 * 1024;

const RECORD_TYPES = ["meta", "program", "data", "control", "html", "legal", "delta"] as const;

export interface InspectedContentRecord {
  ncaId: string;
  type: string;
  size: number;
  sha256: string;
  compressed: boolean;
}

export interface InspectedMeta {
  titleId: string;
  version: number | null;
  type: ContentMetaType;
  applicationId: string;
  applicationIdSource: ApplicationIdSource;
  displayName: string;
  keyGeneration: number | null;
  rightsId: string | null;
  requiredSystemVersion: number | null;
  installSize: number | null;
  source: "filename" | "ticket" | "cnmt" | "nacp";
  records: InspectedContentRecord[];
  publisher: string | null;
  icon: Buffer | null;
}

export interface InspectedHomebrew {
  name: string;
  publisher: string | null;
  version: string | null;
  icon: Buffer | null;
}

export interface InspectedApplication {
  applicationId: string;
  name: string;
  publisher: string | null;
  icon: Buffer | null;
}

export interface InspectionResult {
  entries: PartitionEntry[];
  metas: InspectedMeta[];
  homebrew: InspectedHomebrew | null;
  application: InspectedApplication | null;
  metadataSource: "filename" | "ticket" | "cnmt" | "nacp" | null;
  warnings: string[];
}

export interface InspectOptions {
  keys?: Keyset | null;
}

/** "Some Game [0100…][v0].nsp" → "Some Game" */
export function displayNameFromFileName(fileName: string): string {
  const stem = fileName.replace(/\.[^.]+$/, "");
  const cleaned = stem
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[\s_\-–]+$/, "")
    .trim();
  return cleaned || stem;
}

function applicationFor(
  titleId: string,
  type: ContentMetaType,
  applicationsInFile: string[],
): Pick<InspectedMeta, "applicationId" | "applicationIdSource"> {
  switch (type) {
    case "application":
      return { applicationId: titleId, applicationIdSource: "exact" };
    case "patch":
      return { applicationId: applicationIdForPatch(titleId), applicationIdSource: "derived" };
    case "addon":
      if (applicationsInFile.length === 1 && applicationsInFile[0]) {
        return { applicationId: applicationsInFile[0], applicationIdSource: "derived" };
      }
      return { applicationId: guessApplicationIdForAddon(titleId), applicationIdSource: "guess" };
  }
}

function emptyMetaFields(): Pick<
  InspectedMeta,
  "requiredSystemVersion" | "installSize" | "records" | "publisher" | "icon"
> {
  return {
    requiredSystemVersion: null,
    installSize: null,
    records: [],
    publisher: null,
    icon: null,
  };
}

/** Parses the file's tickets by title ID. Unreadable ones are reported in `warnings`. */
export async function readTickets(
  reader: RandomAccessReader,
  entries: PartitionEntry[],
  warnings: string[],
) {
  const tickets = new Map<string, TicketInfo>();
  for (const entry of entries) {
    if (entry.kind !== "tik") continue;
    if (entry.size > MAX_TICKET_SIZE) {
      warnings.push(`Skipped oversized ticket ${entry.name}`);
      continue;
    }
    try {
      const ticket = parseTicket(await readExact(reader, entry.offset, entry.size));
      tickets.set(ticket.titleId, ticket);
    } catch (err) {
      if (!(err instanceof FormatError)) throw err;
      warnings.push(`Unreadable ticket ${entry.name}: ${err.message}`);
    }
  }
  return tickets;
}

async function inspectHomebrew(
  reader: RandomAccessReader,
  fileName: string,
): Promise<InspectionResult> {
  const info = await parseNro(reader);
  const icon =
    info.icon && info.icon.size <= MAX_ICON_SIZE
      ? await readExact(reader, info.icon.offset, info.icon.size)
      : null;
  return {
    entries: [],
    metas: [],
    homebrew: {
      name: info.nacp?.name || displayNameFromFileName(fileName),
      publisher: info.nacp?.publisher || null,
      version: info.nacp?.displayVersion || null,
      icon,
    },
    application: null,
    metadataSource: info.nacp ? "nacp" : "filename",
    warnings: [],
  };
}

function ncaIdFromName(name: string): string | null {
  const match = /^([0-9a-f]{32})\./i.exec(name);
  return match?.[1]?.toLowerCase() ?? null;
}

function findEntry(entries: PartitionEntry[], ncaId: string): PartitionEntry | undefined {
  const stem = ncaId.toLowerCase();
  return entries.find((entry) => ncaIdFromName(entry.name) === stem);
}

function isNcz(entry: PartitionEntry): boolean {
  return entry.kind === "ncz" || entry.name.toLowerCase().endsWith(".ncz");
}

function recordType(type: number): string {
  return RECORD_TYPES[type] ?? `type-${type}`;
}

function recordsFor(
  contents: CnmtContentRecord[],
  entries: PartitionEntry[],
): InspectedContentRecord[] {
  return contents.map((content) => {
    const entry = findEntry(entries, content.ncaId);
    return {
      ncaId: content.ncaId,
      type: recordType(content.type),
      size: content.size,
      sha256: content.sha256,
      compressed: entry ? isNcz(entry) : false,
    };
  });
}

async function ncaReaderFor(
  parent: RandomAccessReader,
  entry: PartitionEntry,
): Promise<RandomAccessReader> {
  const slice = new SliceReader(parent, entry.offset, entry.size);
  if (!isNcz(entry)) return slice;
  return new BufferReader(await decompressNczToBuffer(slice));
}

/**
 * The title key for a rights-ID NCA from a matching common ticket. Undefined, with a warning, when
 * there is no usable ticket, and undefined without one when the NCA has no rights ID.
 */
export function titleKeyFor(
  keys: Keyset,
  header: Buffer,
  tickets: Map<string, TicketInfo>,
  warnings: string[],
  label: string,
): Buffer | undefined {
  const rights = header.subarray(0x230, 0x240);
  if (rights.every((b) => b === 0)) return undefined;
  const rightsId = rights.toString("hex").toUpperCase();
  const titleId = header.readBigUInt64LE(0x210).toString(16).toUpperCase().padStart(16, "0");
  const ticket = [...tickets.values()].find((t) => t.rightsId === rightsId) ?? tickets.get(titleId);
  if (!ticket) {
    warnings.push(`${label} needs a title key (${rightsId}) and no matching ticket was found`);
    return undefined;
  }
  if (ticket.titleKeyType === "personalized") {
    warnings.push(`${label} uses a personalized ticket, which NSLibrary can't decrypt`);
    return undefined;
  }
  const keyGeneration = Math.max(header.readUInt8(0x206), header.readUInt8(0x220));
  return decryptTitleKey(keys, ticket.titleKeyBlock, keyGeneration);
}

async function withTitleKey<T>(
  reader: RandomAccessReader,
  keys: Keyset,
  tickets: Map<string, TicketInfo>,
  warnings: string[],
  label: string,
  run: (titleKey?: Buffer) => Promise<T>,
): Promise<T | null> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof MissingKeyError && err.keyName.startsWith("title key")) {
      const header = decryptNcaHeader(await readExact(reader, 0, NCA_HEADER_SIZE), keys);
      const titleKey = titleKeyFor(keys, header, tickets, warnings, label);
      if (!titleKey) return null;
      return run(titleKey);
    }
    throw err;
  }
}

async function readCnmtEntry(
  parent: RandomAccessReader,
  entry: PartitionEntry,
  keys: Keyset,
  tickets: Map<string, TicketInfo>,
  warnings: string[],
): Promise<CnmtInfo | null> {
  if (entry.size > MAX_PARSEABLE_NCA) {
    warnings.push(`Skipped oversized content metadata ${entry.name}`);
    return null;
  }
  try {
    const reader = await ncaReaderFor(parent, entry);
    return await withTitleKey(reader, keys, tickets, warnings, entry.name, (titleKey) =>
      readCnmtFromMetaNca(reader, keys, titleKey),
    );
  } catch (err) {
    if (err instanceof MissingKeyError) {
      warnings.push(`${entry.name}: ${err.message}`);
      return null;
    }
    if (err instanceof FormatError) {
      warnings.push(`Couldn't read content metadata ${entry.name}: ${err.message}`);
      return null;
    }
    throw err;
  }
}

async function readControlEntry(
  parent: RandomAccessReader,
  entry: PartitionEntry,
  keys: Keyset,
  tickets: Map<string, TicketInfo>,
  warnings: string[],
) {
  if (entry.size > MAX_PARSEABLE_NCA) return null;
  try {
    const reader = await ncaReaderFor(parent, entry);
    return await withTitleKey(reader, keys, tickets, warnings, entry.name, (titleKey) =>
      readControlNca(reader, keys, titleKey),
    );
  } catch (err) {
    if (err instanceof MissingKeyError) {
      warnings.push(`${entry.name}: ${err.message}`);
      return null;
    }
    if (err instanceof FormatError) {
      warnings.push(`Couldn't read control NCA ${entry.name}: ${err.message}`);
      return null;
    }
    throw err;
  }
}

function cnmtType(kind: CnmtInfo["kind"]): ContentMetaType | null {
  if (kind === "other") return null;
  return kind;
}

async function inspectWithKeys(
  reader: RandomAccessReader,
  entries: PartitionEntry[],
  tickets: Map<string, TicketInfo>,
  keys: Keyset,
  fileName: string,
  warnings: string[],
): Promise<InspectedMeta[]> {
  const metas: InspectedMeta[] = [];
  const displayName = displayNameFromFileName(fileName);

  for (const entry of entries) {
    if (entry.kind !== "cnmt") continue;
    const cnmt = await readCnmtEntry(reader, entry, keys, tickets, warnings);
    if (!cnmt) continue;
    const type = cnmtType(cnmt.kind);
    if (!type) {
      warnings.push(`Ignored system content metadata ${entry.name}`);
      continue;
    }

    const controlRecord = cnmt.contents.find((c) => recordType(c.type) === "control");
    const controlEntry = controlRecord ? findEntry(entries, controlRecord.ncaId) : undefined;
    const control = controlEntry
      ? await readControlEntry(reader, controlEntry, keys, tickets, warnings)
      : null;

    const ticket = tickets.get(cnmt.titleId);
    metas.push({
      titleId: cnmt.titleId,
      version: cnmt.version,
      type,
      applicationId: cnmt.applicationId,
      applicationIdSource: type === "application" ? "exact" : "derived",
      displayName: control?.nacp.name || displayName,
      keyGeneration: ticket?.keyGeneration ?? null,
      rightsId: ticket?.rightsId ?? null,
      requiredSystemVersion: cnmt.requiredSystemVersion,
      installSize: cnmt.installSize,
      source: control ? "nacp" : "cnmt",
      records: recordsFor(cnmt.contents, entries),
      publisher: control?.nacp.publisher || null,
      icon: type === "addon" ? null : (control?.icon ?? null),
    });
  }

  return metas;
}

function fallbackMetas(fileName: string, tickets: Map<string, TicketInfo>): InspectedMeta[] {
  const fromName = parseTitleFilename(fileName);
  const titleIds = new Set(tickets.keys());
  if (fromName.titleId) titleIds.add(fromName.titleId);
  const sorted = [...titleIds].sort();
  const applicationsInFile = sorted.filter((tid) => inferTypeFromTitleId(tid) === "application");
  const displayName = displayNameFromFileName(fileName);

  return sorted.map((titleId): InspectedMeta => {
    const type = inferTypeFromTitleId(titleId);
    const ticket = tickets.get(titleId);
    const versionApplies =
      fromName.titleId === titleId || (fromName.titleId === undefined && sorted.length === 1);
    return {
      titleId,
      type,
      ...applicationFor(titleId, type, applicationsInFile),
      version: versionApplies ? (fromName.version ?? null) : null,
      displayName,
      keyGeneration: ticket?.keyGeneration ?? null,
      rightsId: ticket?.rightsId ?? null,
      source: ticket ? "ticket" : "filename",
      ...emptyMetaFields(),
    };
  });
}

function mergeMetas(fromKeys: InspectedMeta[], fallback: InspectedMeta[]): InspectedMeta[] {
  if (fromKeys.length === 0) return fallback;
  const byId = new Map(fromKeys.map((meta) => [meta.titleId, meta]));
  for (const meta of fallback) {
    if (!byId.has(meta.titleId)) byId.set(meta.titleId, meta);
  }
  return [...byId.values()].sort((a, b) => a.titleId.localeCompare(b.titleId));
}

function bestSource(metas: InspectedMeta[]): InspectionResult["metadataSource"] {
  if (metas.length === 0) return null;
  if (metas.some((m) => m.source === "nacp")) return "nacp";
  if (metas.some((m) => m.source === "cnmt")) return "cnmt";
  if (metas.some((m) => m.source === "ticket")) return "ticket";
  return "filename";
}

function applicationFrom(metas: InspectedMeta[]): InspectedApplication | null {
  const meta =
    metas.find((m) => m.type === "application" && m.source === "nacp") ??
    metas.find((m) => m.type === "patch" && m.source === "nacp");
  if (!meta) return null;
  return {
    applicationId: meta.applicationId,
    name: meta.displayName,
    publisher: meta.publisher,
    icon: meta.icon,
  };
}

export async function inspectLibraryFile(
  reader: RandomAccessReader,
  fileName: string,
  format: LibraryFileFormat,
  options: InspectOptions = {},
): Promise<InspectionResult> {
  if (format === "nro") return inspectHomebrew(reader, fileName);

  const warnings: string[] = [];
  const entries = await listContainerEntries(reader, format);
  if (!entries.some((e) => e.kind === "cnmt")) {
    warnings.push("No content metadata (.cnmt.nca) entry found");
  }
  const tickets = await readTickets(reader, entries, warnings);
  const fallback = fallbackMetas(fileName, tickets);

  let fromKeys: InspectedMeta[] = [];
  const keys = options.keys;
  if (keys?.has("header_key")) {
    fromKeys = await inspectWithKeys(reader, entries, tickets, keys, fileName, warnings);
  }

  const metas = mergeMetas(fromKeys, fallback);
  return {
    entries,
    metas,
    homebrew: null,
    application: applicationFrom(metas),
    metadataSource: bestSource(metas),
    warnings,
  };
}
