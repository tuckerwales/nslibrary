/**
 * Homebrew NRO executables. The optional asset section after the NRO body holds the icon
 * (JPEG), the NACP (name, author, version) and a RomFS.
 */
import { FormatError, readMagic, readU64 } from "./binary";
import { type RandomAccessReader, readExact } from "./reader";

export const NACP_SIZE = 0x4000;
const NRO_HEADER_READ_SIZE = 0x80;
const ASSET_HEADER_SIZE = 0x38;

export interface NacpInfo {
  name: string;
  publisher: string;
  displayVersion: string;
  /** 16 uppercase hex digits; the first DLC title ID for retail applications. */
  addOnContentBaseId: string;
}

export interface AssetSection {
  /** Absolute offset within the reader. */
  offset: number;
  size: number;
}

export interface NroInfo {
  /** Size of the executable part; assets start here. */
  nroSize: number;
  icon: AssetSection | null;
  nacp: NacpInfo | null;
  romfs: AssetSection | null;
}

function cString(buf: Buffer, offset: number, maxLength: number): string {
  const nul = buf.indexOf(0, offset);
  const end = nul === -1 || nul > offset + maxLength ? offset + maxLength : nul;
  return buf.toString("utf8", offset, end).trim();
}

/** Reads the first-language name/publisher plus version fields of a NACP. */
export function parseNacp(nacp: Buffer): NacpInfo {
  if (nacp.length < 0x3078) {
    throw new FormatError("TRUNCATED", `NACP is ${nacp.length} bytes, expected ${NACP_SIZE}`);
  }
  return {
    name: cString(nacp, 0x0, 0x200),
    publisher: cString(nacp, 0x200, 0x100),
    displayVersion: cString(nacp, 0x3060, 0x10),
    addOnContentBaseId: nacp.readBigUInt64LE(0x3070).toString(16).toUpperCase().padStart(16, "0"),
  };
}

export async function parseNro(reader: RandomAccessReader): Promise<NroInfo> {
  const header = await readExact(reader, 0, NRO_HEADER_READ_SIZE);
  if (readMagic(header, 0x10, 4) !== "NRO0") {
    throw new FormatError("BAD_MAGIC", "no NRO0 magic at 0x10");
  }
  const nroSize = header.readUInt32LE(0x18);
  if (nroSize < NRO_HEADER_READ_SIZE)
    throw new FormatError("INVALID", `NRO size ${nroSize} is too small`);
  if (nroSize > reader.size)
    throw new FormatError("TRUNCATED", "NRO is shorter than its header claims");

  const noAssets: NroInfo = { nroSize, icon: null, nacp: null, romfs: null };
  if (nroSize + ASSET_HEADER_SIZE > reader.size) return noAssets;
  const assets = await readExact(reader, nroSize, ASSET_HEADER_SIZE);
  if (readMagic(assets, 0, 4) !== "ASET") return noAssets;

  const section = (fieldOffset: number): AssetSection | null => {
    const size = readU64(assets, fieldOffset + 0x08);
    if (size === 0) return null;
    const offset = nroSize + readU64(assets, fieldOffset);
    if (offset + size > reader.size) {
      throw new FormatError("TRUNCATED", "NRO asset section extends past end of file");
    }
    return { offset, size };
  };

  const nacpSection = section(0x18);
  return {
    nroSize,
    icon: section(0x08),
    nacp: nacpSection
      ? parseNacp(
          await readExact(reader, nacpSection.offset, Math.min(nacpSection.size, NACP_SIZE)),
        )
      : null,
    romfs: section(0x28),
  };
}
