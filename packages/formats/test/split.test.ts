import { describe, expect, it } from "vitest";
import { BufferReader, ConcatReader } from "../src/reader";
import {
  detectSplitDirectory,
  groupNumberedSplitFiles,
  isSplitRelatedFileName,
  parseNumberedSplitName,
  splitPartIndex,
} from "../src/split";

describe("split part names", () => {
  it("accepts two-digit part files and numbered container names", () => {
    expect(splitPartIndex("00")).toBe(0);
    expect(splitPartIndex("09")).toBe(9);
    expect(splitPartIndex("0")).toBeNull();
    expect(splitPartIndex("game.nsp")).toBeNull();
    expect(parseNumberedSplitName("Game [0100][v0].nsp.00")).toEqual({
      stem: "Game [0100][v0].nsp",
      index: 0,
      format: "nsp",
    });
    expect(parseNumberedSplitName("Game.nsp")).toBeNull();
    expect(isSplitRelatedFileName("01")).toBe(true);
    expect(isSplitRelatedFileName("notes.txt")).toBe(false);
  });
});

describe("detectSplitDirectory", () => {
  it("requires a container extension and consecutive parts from 00", () => {
    expect(
      detectSplitDirectory("Title.nsp", [
        { name: "00", isFile: true },
        { name: "01", isFile: true },
        { name: ".DS_Store", isFile: true },
      ]),
    ).toMatchObject({
      format: "nsp",
      relName: "Title.nsp",
      parts: [
        { name: "00", index: 0 },
        { name: "01", index: 1 },
      ],
    });
    expect(detectSplitDirectory("Title.nsp", [{ name: "00", isFile: true }])).not.toBeNull();
    expect(
      detectSplitDirectory("Title.nsp", [
        { name: "00", isFile: true },
        { name: "02", isFile: true },
      ]),
    ).toBeNull();
    expect(detectSplitDirectory("Title", [{ name: "00", isFile: true }])).toBeNull();
  });
});

describe("groupNumberedSplitFiles", () => {
  it("groups Game.nsp.00 / .01 and ignores gaps", () => {
    expect(
      groupNumberedSplitFiles(["a.nsp.00", "a.nsp.01", "b.xci.00", "c.nsp.00", "c.nsp.02"]),
    ).toEqual([
      {
        format: "nsp",
        relName: "a.nsp",
        parts: [
          { name: "a.nsp.00", index: 0 },
          { name: "a.nsp.01", index: 1 },
        ],
      },
      { format: "xci", relName: "b.xci", parts: [{ name: "b.xci.00", index: 0 }] },
    ]);
  });
});

describe("ConcatReader", () => {
  it("reads across part boundaries", async () => {
    const reader = new ConcatReader([
      { reader: new BufferReader(Buffer.from("AAAA")), size: 4 },
      { reader: new BufferReader(Buffer.from("BBBB")), size: 4 },
      { reader: new BufferReader(Buffer.from("CC")), size: 2 },
    ]);
    expect(reader.size).toBe(10);
    expect(await reader.read(0, 4)).toEqual(Buffer.from("AAAA"));
    expect(await reader.read(3, 4)).toEqual(Buffer.from("ABBB"));
    expect(await reader.read(7, 3)).toEqual(Buffer.from("BCC"));
    expect(await reader.read(9, 8)).toEqual(Buffer.from("C"));
    expect(await reader.read(10, 4)).toEqual(Buffer.alloc(0));
  });
});
