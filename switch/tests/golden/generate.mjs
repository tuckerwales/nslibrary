#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { constants, zstdCompressSync } from "node:zlib";

/** Rebuild switch/tests/golden binaries. Run from the repo root: `node switch/tests/golden/generate.mjs` */

const dir = path.dirname(fileURLToPath(import.meta.url));
fs.mkdirSync(dir, { recursive: true });

function det(seed, length) {
  const key = crypto.createHash("sha256").update(seed).digest().subarray(0, 16);
  return crypto.createCipheriv("aes-128-ctr", key, Buffer.alloc(16)).update(Buffer.alloc(length));
}

function mixedBytes(seed, length, runSize = 0x10000) {
  const out = Buffer.alloc(length);
  const text = Buffer.from(`nslibrary fixture ${seed} `);
  for (let position = 0, run = 0; position < length; position += runSize, run++) {
    const n = Math.min(runSize, length - position);
    if (run % 2 === 0) {
      for (let i = 0; i < n; i++) out[position + i] = text[i % text.length] ?? 0;
    } else {
      det(`${seed}:run${run}`, n).copy(out, position);
    }
  }
  return out;
}

function writeTitleId(buf, offset, titleId) {
  buf.writeBigUInt64LE(BigInt(`0x${titleId}`), offset);
}

function buildPfs0(files, align = 0x20) {
  return buildPartition("PFS0", 0x18, files, align, () => {});
}

function buildHfs0(files, align = 0x20, hashedSize = 0x200) {
  return buildPartition("HFS0", 0x40, files, align, (header, o, file) => {
    const covered = Math.min(hashedSize, file.data.length);
    header.writeUInt32LE(covered, o + 0x14);
    crypto
      .createHash("sha256")
      .update(file.data.subarray(0, covered))
      .digest()
      .copy(header, o + 0x20);
  });
}

function buildPartition(magic, entrySize, files, align, writeExtra) {
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
  header.write(magic, 0, "latin1");
  header.writeUInt32LE(files.length, 4);
  header.writeUInt32LE(table.length, 8);
  let dataOffset = 0;
  files.forEach((file, i) => {
    const o = 0x10 + i * entrySize;
    header.writeBigUInt64LE(BigInt(dataOffset), o);
    header.writeBigUInt64LE(BigInt(file.data.length), o + 0x08);
    header.writeUInt32LE(offsets[i], o + 0x10);
    writeExtra(header, o, file);
    dataOffset += file.data.length;
  });
  return Buffer.concat([header, table, ...files.map((f) => f.data)]);
}

function partitionHeaderSize(partition) {
  const entrySize = partition.toString("latin1", 0, 4) === "HFS0" ? 0x40 : 0x18;
  return 0x10 + partition.readUInt32LE(4) * entrySize + partition.readUInt32LE(8);
}

function buildXci(secure, options = {}) {
  const partitions = [
    { name: "update", data: buildHfs0(options.update ?? []) },
    { name: "normal", data: buildHfs0(options.normal ?? []) },
  ];
  if (!options.omitSecure) partitions.push({ name: "secure", data: buildHfs0(secure) });
  if (options.emptyLogo) partitions.push({ name: "logo", data: new Uint8Array(0) });
  const root = buildHfs0(partitions);
  const card = Buffer.alloc(0xf000);
  det("xci:signature", 0x100).copy(card, 0);
  card.write("HEAD", 0x100, "latin1");
  card.writeBigUInt64LE(BigInt(0xf000), 0x130);
  card.writeBigUInt64LE(BigInt(partitionHeaderSize(root)), 0x138);
  const image = Buffer.concat([card, root]);
  return options.keyArea ? Buffer.concat([det("xci:key-area", 0x1000), image]) : image;
}

function ctrTransform(key, counter, offset, data) {
  const blockIndex = Math.floor(offset / 16);
  const iv = Buffer.concat([counter.subarray(0, 8), Buffer.alloc(8)]);
  iv.writeBigUInt64BE(BigInt(blockIndex), 8);
  const keystream = crypto
    .createCipheriv("aes-128-ctr", key, iv)
    .update(Buffer.alloc(offset - blockIndex * 16 + data.length));
  const out = Buffer.alloc(data.length);
  const skip = offset - blockIndex * 16;
  for (let i = 0; i < data.length; i++) out[i] = (data[i] ?? 0) ^ (keystream[skip + i] ?? 0);
  return out;
}

function aesCtrAt(key, counter, offset, data) {
  const aligned = offset - (offset % 16);
  const iv = Buffer.alloc(16);
  counter.copy(iv, 0, 0, 8);
  iv.writeBigUInt64BE(BigInt(aligned / 16), 8);
  const cipher = crypto.createCipheriv("aes-128-ctr", key, iv);
  if (offset !== aligned) cipher.update(Buffer.alloc(offset - aligned));
  return cipher.update(data);
}

function buildFixtureNca(seed, specs) {
  const PREFIX = 0x4000;
  const prefix = det(`${seed}:prefix`, PREFIX);
  const plainParts = [prefix];
  const encryptedParts = [prefix];
  const sections = [];
  let offset = PREFIX;
  specs.forEach((spec, i) => {
    const plain = mixedBytes(`${seed}:section${i}`, spec.size);
    const cryptoKey = det(`${seed}:key${i}`, 16);
    const cryptoCounter = Buffer.concat([det(`${seed}:nonce${i}`, 8), Buffer.alloc(8)]);
    plainParts.push(plain);
    encryptedParts.push(
      spec.encrypted ? ctrTransform(cryptoKey, cryptoCounter, offset, plain) : plain,
    );
    sections.push({
      offset,
      size: spec.size,
      cryptoType: spec.encrypted ? 3 : 1,
      cryptoKey,
      cryptoCounter,
    });
    offset += spec.size;
  });
  return {
    encrypted: Buffer.concat(encryptedParts),
    plaintext: Buffer.concat(plainParts),
    sections,
  };
}

function buildNcz(nca, options) {
  const PREFIX = 0x4000;
  const body = nca.plaintext.subarray(PREFIX);
  const zstdOptions = { params: { [constants.ZSTD_c_compressionLevel]: options.level ?? 3 } };
  const table = Buffer.alloc(0x10 + nca.sections.length * 0x40);
  table.write("NCZSECTN", 0, "latin1");
  table.writeBigUInt64LE(BigInt(nca.sections.length), 0x08);
  nca.sections.forEach((section, i) => {
    const o = 0x10 + i * 0x40;
    table.writeBigUInt64LE(BigInt(section.offset), o);
    table.writeBigUInt64LE(BigInt(section.size), o + 0x08);
    table.writeBigUInt64LE(BigInt(section.cryptoType), o + 0x10);
    section.cryptoKey.copy(table, o + 0x20);
    section.cryptoCounter.copy(table, o + 0x30);
  });
  const prefix = nca.encrypted.subarray(0, PREFIX);
  if (options.mode === "solid") {
    return Buffer.concat([prefix, table, zstdCompressSync(body, zstdOptions)]);
  }
  const blockSize = 2 ** options.blockSizeExponent;
  const blockCount = Math.ceil(body.length / blockSize);
  const blockHeader = Buffer.alloc(0x18 + blockCount * 4);
  blockHeader.write("NCZBLOCK", 0, "latin1");
  blockHeader.writeUInt8(2, 0x08);
  blockHeader.writeUInt8(1, 0x09);
  blockHeader.writeUInt8(options.blockSizeExponent, 0x0b);
  blockHeader.writeUInt32LE(blockCount, 0x0c);
  blockHeader.writeBigUInt64LE(BigInt(body.length), 0x10);
  const blocks = [];
  for (let i = 0; i < blockCount; i++) {
    const raw = body.subarray(i * blockSize, Math.min((i + 1) * blockSize, body.length));
    const compressed = zstdCompressSync(raw, zstdOptions);
    const stored = compressed.length < raw.length ? compressed : raw;
    blockHeader.writeUInt32LE(stored.length, 0x18 + i * 4);
    blocks.push(stored);
  }
  return Buffer.concat([prefix, table, blockHeader, ...blocks]);
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

const nca = buildFixtureNca("ncz-test", [
  { size: 0x30003, encrypted: true },
  { size: 0x1ff1, encrypted: false },
  { size: 0x2400b, encrypted: true },
]);
const nczSolid = buildNcz(nca, { mode: "solid" });
const nczBlock = buildNcz(nca, { mode: "block", blockSizeExponent: 14 });
const ncaSha = crypto.createHash("sha256").update(nca.encrypted).digest("hex");
const ncaId = ncaSha.slice(0, 32);

const identityCnmt = buildCnmt({
  titleId: TITLE,
  version: 0,
  type: 0x80,
  requiredSystemVersion: 0x0c0000,
  contents: [{ nca: nca.encrypted, type: 1 }],
});
const identityCnmtHash = crypto.createHash("sha256").update(identityCnmt).digest();
const nspIdentity = buildPfs0([
  { name: `${identityCnmtHash.subarray(0, 16).toString("hex")}.cnmt.nca`, data: identityCnmt },
  { name: `${ncaId}.nca`, data: nca.encrypted },
]);
const nszIdentity = buildPfs0([
  { name: `${identityCnmtHash.subarray(0, 16).toString("hex")}.cnmt.nca`, data: identityCnmt },
  { name: `${ncaId}.ncz`, data: nczSolid },
]);

const hfs0Files = [
  { name: "0123456789abcdef0123456789abcdef.cnmt.nca", data: det("cnmt", 0x321) },
  { name: "fedcba9876543210fedcba9876543210.nca", data: det("program", 0x2000) },
  { name: "00112233445566778899aabbccddeeff.ncz", data: det("ncz", 0x77) },
  { name: "0100000000010000000000000000000a.tik", data: det("tik", 0x2c0) },
  { name: "0100000000010000000000000000000a.cert", data: det("cert", 0x700) },
  { name: "empty.txt", data: Buffer.alloc(0) },
];
const hfs0 = buildHfs0(hfs0Files, 0x20, 0x100);
const xci = buildXci(hfs0Files, {
  emptyLogo: true,
  update: [{ name: "system-update.nca", data: det("update", 0x40) }],
});
const xciKey = buildXci(hfs0Files, { keyArea: true });

const ctrKey = Buffer.from("00112233445566778899aabbccddeeff", "hex");
const ctrNonce = Buffer.from("0102030405060708", "hex");
const ctrPlain = Buffer.from("hello nslibrary ctr!!");
const ctrOffset = 0x4001;
const ctrOut = aesCtrAt(ctrKey, Buffer.concat([ctrNonce, Buffer.alloc(8)]), ctrOffset, ctrPlain);

const emptySha = crypto.createHash("sha256").update(Buffer.alloc(0)).digest("hex");

const pfs0 = buildPfs0(files);
fs.writeFileSync(path.join(dir, "cnmt.bin"), cnmt);
fs.writeFileSync(path.join(dir, "ticket.bin"), ticket);
fs.writeFileSync(path.join(dir, "pfs0.bin"), pfs0);
fs.writeFileSync(path.join(dir, "empty.pfs0.bin"), buildPfs0([]));
fs.writeFileSync(path.join(dir, "hfs0.bin"), hfs0);
fs.writeFileSync(path.join(dir, "xci.bin"), xci);
fs.writeFileSync(path.join(dir, "xci-keyarea.bin"), xciKey);
fs.writeFileSync(path.join(dir, "nca.bin"), nca.encrypted);
fs.writeFileSync(path.join(dir, "ncz-solid.bin"), nczSolid);
fs.writeFileSync(path.join(dir, "ncz-block.bin"), nczBlock);
fs.writeFileSync(path.join(dir, "nsp-identity.bin"), nspIdentity);
fs.writeFileSync(path.join(dir, "nsz-identity.bin"), nszIdentity);

const expect = {
  titleId: TITLE,
  version: 0,
  kind: "application",
  applicationId: TITLE,
  requiredSystemVersion: 0x0c0000,
  contents: [
    { ncaId: programHash.subarray(0, 16).toString("hex"), size: program.length, type: 1 },
    { ncaId: controlHash.subarray(0, 16).toString("hex"), size: control.length, type: 3 },
  ],
  ticket: {
    rightsId: rightsId.toUpperCase(),
    titleId: TITLE,
    keyGeneration: 11,
    issuer: "Root-CA00000003-XS00000020",
  },
  pfs0: {
    names: files.map((f) => f.name),
    kinds: ["cnmt", "nca", "nca", "tik", "cert"],
    sizes: files.map((f) => f.data.length),
    headerSize: 352,
  },
  hfs0: {
    names: hfs0Files.map((f) => f.name),
    kinds: ["cnmt", "nca", "ncz", "tik", "cert", "other"],
    sizes: hfs0Files.map((f) => f.data.length),
    hashedSize: 0x100,
  },
  ncz: {
    ncaSize: nca.encrypted.length,
    ncaSha256: ncaSha,
    ncaId,
    sections: nca.sections.map((s) => ({
      offset: s.offset,
      size: s.size,
      cryptoType: s.cryptoType,
    })),
    solidSmaller: nczSolid.length < nca.encrypted.length,
  },
  crypto: {
    emptySha256: emptySha,
    ctrOffset,
    ctrKey: ctrKey.toString("hex"),
    ctrNonce: ctrNonce.toString("hex"),
    ctrPlain: ctrPlain.toString("hex"),
    ctrOut: ctrOut.toString("hex"),
  },
};

fs.writeFileSync(path.join(dir, "expected.json"), `${JSON.stringify(expect, null, 2)}\n`);
console.log("wrote", dir);
