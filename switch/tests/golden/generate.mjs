#!/usr/bin/env node
/** Rebuild switch/tests/golden binaries. Run from the repo root: `node switch/tests/golden/generate.mjs` */
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const dir = path.join(__dirname);
fs.mkdirSync(dir, { recursive: true });

function det(seed, length) {
  const key = crypto.createHash("sha256").update(seed).digest().subarray(0, 16);
  return crypto.createCipheriv("aes-128-ctr", key, Buffer.alloc(16)).update(Buffer.alloc(length));
}

function writeTitleId(buf, offset, titleId) {
  buf.writeBigUInt64LE(BigInt(`0x${titleId}`), offset);
}

function buildPfs0(files, align = 0x20) {
  const entrySize = 0x18;
  const fixedSize = 0x10 + files.length * entrySize;
  const offsets = [];
  const parts = [];
  let length = 0;
  for (const file of files) {
    offsets.push(length);
    const encoded = Buffer.from(`${file.name}\0`, "utf8");
    parts.push(encoded);
    length += encoded.length;
  }
  const padding = (align - ((fixedSize + length) % align)) % align;
  parts.push(Buffer.alloc(padding));
  const table = Buffer.concat(parts);
  const header = Buffer.alloc(fixedSize);
  header.write("PFS0", 0, "latin1");
  header.writeUInt32LE(files.length, 4);
  header.writeUInt32LE(table.length, 8);
  let dataOffset = 0;
  files.forEach((file, i) => {
    const o = 0x10 + i * entrySize;
    header.writeBigUInt64LE(BigInt(dataOffset), o);
    header.writeBigUInt64LE(BigInt(file.data.length), o + 0x08);
    header.writeUInt32LE(offsets[i], o + 0x10);
    dataOffset += file.data.length;
  });
  return Buffer.concat([header, table, ...files.map((f) => f.data)]);
}

function buildCnmt(options) {
  const extendedSize = options.type === 0x80 ? 0x10 : 0x18;
  const tableOffset = 0x20 + extendedSize;
  const body = Buffer.alloc(tableOffset + options.contents.length * 0x38 + 0x20);
  writeTitleId(body, 0, options.titleId);
  body.writeUInt32LE(options.version, 0x8);
  body.writeUInt8(options.type, 0xc);
  body.writeUInt16LE(extendedSize, 0xe);
  body.writeUInt16LE(options.contents.length, 0x10);
  if (options.type === 0x80) {
    writeTitleId(body, 0x20, options.titleId.replace(/000$/, "800"));
    body.writeUInt32LE(options.requiredSystemVersion ?? 0, 0x28);
  }
  options.contents.forEach((content, i) => {
    const o = tableOffset + i * 0x38;
    const hash = crypto.createHash("sha256").update(content.nca).digest();
    hash.copy(body, o);
    hash.subarray(0, 16).copy(body, o + 0x20);
    body.writeUIntLE(content.nca.length, o + 0x30, 5);
    body.writeUInt8(content.type, o + 0x36);
  });
  return body;
}

function buildTicket(options) {
  const signatureType = 0x10004;
  const signatureSize = 0x100;
  const padding = 0x3c;
  const dataStart = 4 + signatureSize + padding;
  const ticket = Buffer.alloc(dataStart + 0x180);
  ticket.writeUInt32LE(signatureType, 0);
  det(`ticket:${options.rightsId}:signature`, signatureSize).copy(ticket, 4);
  ticket.write("Root-CA00000003-XS00000020", dataStart, "latin1");
  det(`ticket:${options.rightsId}:title-key`, 16).copy(ticket, dataStart + 0x40);
  ticket.writeUInt8(2, dataStart + 0x140);
  ticket.writeUInt8(options.keyGeneration ?? 0, dataStart + 0x145);
  Buffer.from(options.rightsId, "hex").copy(ticket, dataStart + 0x160);
  return ticket;
}

const TITLE = "0100ABCDEF012000";
const program = det("program", 0x2000);
const control = det("control", 0x800);
const cnmt = buildCnmt({
  titleId: TITLE,
  version: 0,
  type: 0x80,
  requiredSystemVersion: 0x0c0000,
  contents: [
    { nca: program, type: 1 },
    { nca: control, type: 3 },
  ],
});
const programHash = crypto.createHash("sha256").update(program).digest();
const controlHash = crypto.createHash("sha256").update(control).digest();
const cnmtHash = crypto.createHash("sha256").update(cnmt).digest();
const rightsId = `${TITLE}${"0".repeat(14)}0b`;
const ticket = buildTicket({ rightsId, keyGeneration: 0x0b });
const cert = det("cert", 0x700);
const files = [
  { name: `${cnmtHash.subarray(0, 16).toString("hex")}.cnmt.nca`, data: cnmt },
  { name: `${programHash.subarray(0, 16).toString("hex")}.nca`, data: program },
  { name: `${controlHash.subarray(0, 16).toString("hex")}.nca`, data: control },
  { name: `${rightsId.toLowerCase()}.tik`, data: ticket },
  { name: `${rightsId.toLowerCase()}.cert`, data: cert },
];
fs.writeFileSync(path.join(dir, "cnmt.bin"), cnmt);
fs.writeFileSync(path.join(dir, "ticket.bin"), ticket);
fs.writeFileSync(path.join(dir, "pfs0.bin"), buildPfs0(files));
fs.writeFileSync(path.join(dir, "empty.pfs0.bin"), buildPfs0([]));
console.log("wrote", dir);
