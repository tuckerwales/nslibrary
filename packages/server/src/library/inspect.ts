/**
 * Keyless inspection of a library file: container entries, title IDs from tickets and the
 * filename, and homebrew NACP data. Metadata that needs keys (CNMT, control NACP) comes in M2.
 */
import {
  FormatError,
  type LibraryFileFormat,
  listContainerEntries,
  type PartitionEntry,
  parseNro,
  parseTicket,
  type RandomAccessReader,
  readExact,
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
export const PARSER_VERSION = 1;

const MAX_TICKET_SIZE = 0x1000;
const MAX_ICON_SIZE = 0x80000;

export interface InspectedMeta {
  titleId: string;
  version: number | null;
  type: ContentMetaType;
  applicationId: string;
  applicationIdSource: ApplicationIdSource;
  displayName: string;
  keyGeneration: number | null;
  rightsId: string | null;
  source: "filename" | "ticket";
}

export interface InspectedHomebrew {
  name: string;
  publisher: string | null;
  version: string | null;
  icon: Buffer | null;
}

export interface InspectionResult {
  entries: PartitionEntry[];
  metas: InspectedMeta[];
  homebrew: InspectedHomebrew | null;
  metadataSource: "filename" | "ticket" | "nacp" | null;
  warnings: string[];
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
      // DLC bundled with exactly one base game in the same file belongs to that game.
      if (applicationsInFile.length === 1 && applicationsInFile[0]) {
        return { applicationId: applicationsInFile[0], applicationIdSource: "derived" };
      }
      return { applicationId: guessApplicationIdForAddon(titleId), applicationIdSource: "guess" };
  }
}

async function readTickets(
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
    metadataSource: info.nacp ? "nacp" : "filename",
    warnings: [],
  };
}

export async function inspectLibraryFile(
  reader: RandomAccessReader,
  fileName: string,
  format: LibraryFileFormat,
): Promise<InspectionResult> {
  if (format === "nro") return inspectHomebrew(reader, fileName);

  const warnings: string[] = [];
  const entries = await listContainerEntries(reader, format);
  if (!entries.some((e) => e.kind === "cnmt")) {
    warnings.push("No content metadata (.cnmt.nca) entry found");
  }
  const tickets = await readTickets(reader, entries, warnings);

  const fromName = parseTitleFilename(fileName);
  const titleIds = new Set(tickets.keys());
  if (fromName.titleId) titleIds.add(fromName.titleId);
  const sorted = [...titleIds].sort();
  const applicationsInFile = sorted.filter((tid) => inferTypeFromTitleId(tid) === "application");
  const displayName = displayNameFromFileName(fileName);

  const metas = sorted.map((titleId): InspectedMeta => {
    const type = inferTypeFromTitleId(titleId);
    const ticket = tickets.get(titleId);
    // A [vNNN] tag describes the title named in the filename, or the only title in the file.
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
    };
  });

  return {
    entries,
    metas,
    homebrew: null,
    metadataSource: metas.length === 0 ? null : tickets.size > 0 ? "ticket" : "filename",
    warnings,
  };
}
