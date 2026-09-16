/**
 * Minimal NPDM (META + unsigned ACID + ACI0) so a program NCA has a `main.npdm`.
 * Homebrew with sigpatches can install the resulting NSP; a real `main` is still
 * required for the title to launch from the HOME menu.
 */

function writeTitleId(buf: Buffer, offset: number, titleId: string): void {
  buf.writeBigUInt64LE(BigInt(`0x${titleId}`), offset);
}

export interface NpdmOptions {
  titleId: string;
  name?: string;
}

export function buildNpdm(options: NpdmOptions): Buffer {
  const name = (options.name ?? "NSLibrary").slice(0, 15);
  const kac = Buffer.alloc(0x20);
  // Kernel flags: highest prio 63, lowest 24, cpu 0–3.
  kac.writeUInt32LE(0x3f00_0018 | (3 << 24), 0);
  // Handle table size 512.
  kac.writeUInt32LE(0x1e00_0200, 4);
  // Application type 1 (application).
  kac.writeUInt32LE(0x1f00_0001, 8);
  // Min kernel version 0x30.
  kac.writeUInt32LE(0x1c00_0030, 12);
  // Debug flags: allow + force debug.
  kac.writeUInt32LE(0x1b00_0003, 16);

  // SAC: allow all services (`*`).
  const sac = Buffer.from([0x01, 0x2a]);
  // FAC: empty FS access (homebrew loader does not need FS descriptors here).
  const fac = Buffer.alloc(0x38);

  const acidBodyOffset = 0x200;
  const acidExtra = Buffer.concat([fac, sac, kac]);
  const acid = Buffer.alloc(acidBodyOffset + 0x40 + acidExtra.length);
  acid.write("ACID", acidBodyOffset, "latin1");
  acid.writeUInt32LE(1, acidBodyOffset + 0x0c); // unsigned
  writeTitleId(acid, acidBodyOffset + 0x10, options.titleId);
  writeTitleId(acid, acidBodyOffset + 0x18, options.titleId);
  acid.writeUInt32LE(0x40, acidBodyOffset + 0x20); // FAC offset from ACID body
  acid.writeUInt32LE(fac.length, acidBodyOffset + 0x24);
  acid.writeUInt32LE(0x40 + fac.length, acidBodyOffset + 0x28);
  acid.writeUInt32LE(sac.length, acidBodyOffset + 0x2c);
  acid.writeUInt32LE(0x40 + fac.length + sac.length, acidBodyOffset + 0x30);
  acid.writeUInt32LE(kac.length, acidBodyOffset + 0x34);
  acidExtra.copy(acid, acidBodyOffset + 0x40);

  const aci0Header = 0x40;
  const aci0 = Buffer.alloc(aci0Header + acidExtra.length);
  aci0.write("ACI0", 0, "latin1");
  writeTitleId(aci0, 0x10, options.titleId);
  aci0.writeUInt32LE(aci0Header, 0x20);
  aci0.writeUInt32LE(fac.length, 0x24);
  aci0.writeUInt32LE(aci0Header + fac.length, 0x28);
  aci0.writeUInt32LE(sac.length, 0x2c);
  aci0.writeUInt32LE(aci0Header + fac.length + sac.length, 0x30);
  aci0.writeUInt32LE(kac.length, 0x34);
  acidExtra.copy(aci0, aci0Header);

  const meta = Buffer.alloc(0x80);
  meta.write("META", 0, "latin1");
  meta.writeUInt8(1, 0x0c); // 64-bit
  meta.writeUInt8(44, 0x0e); // main thread priority
  meta.writeUInt8(3, 0x0f); // core 3
  meta.writeUInt32LE(0x200000, 0x1c); // stack
  meta.write(name, 0x20, 16, "utf8");
  const aci0Offset = 0x80;
  const acidOffset = aci0Offset + aci0.length;
  meta.writeUInt32LE(aci0Offset, 0x70);
  meta.writeUInt32LE(aci0.length, 0x74);
  meta.writeUInt32LE(acidOffset, 0x78);
  meta.writeUInt32LE(acid.length, 0x7c);

  return Buffer.concat([meta, aci0, acid]);
}
