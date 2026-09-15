import { buildNro, buildTicket, fakeJpeg, rightsIdFor } from "@nslib/fixtures";
import { describe, expect, it } from "vitest";
import { BufferReader, FormatError, parseNro, parseTicket } from "../src/index";

function expectFormatError(fn: () => unknown, code: FormatError["code"]) {
  try {
    fn();
    expect.unreachable();
  } catch (err) {
    expect(err).toBeInstanceOf(FormatError);
    expect((err as FormatError).code).toBe(code);
  }
}

async function expectAsyncFormatError(promise: Promise<unknown>, code: FormatError["code"]) {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(FormatError);
  expect((error as FormatError).code).toBe(code);
}

describe("parseTicket", () => {
  const rightsId = rightsIdFor("0100ABCDEF012000", 0x0b);

  it.each([0x10000, 0x10003, 0x10004, 0x10005] as const)(
    "reads title ID and key generation with signature type %s",
    (signatureType) => {
      const info = parseTicket(buildTicket({ rightsId, keyGeneration: 0x0b, signatureType }));
      expect(info.signatureType).toBe(signatureType);
      expect(info.rightsId).toBe(rightsId);
      expect(info.titleId).toBe("0100ABCDEF012000");
      expect(info.keyGeneration).toBe(0x0b);
      expect(info.issuer).toBe("Root-CA00000003-XS00000020");
      expect(info.titleKeyType).toBe("common");
      expect(info.titleKeyBlock).toHaveLength(0x100);
    },
  );

  it("flags personalized tickets", () => {
    expect(parseTicket(buildTicket({ rightsId, personalized: true })).titleKeyType).toBe(
      "personalized",
    );
  });

  it("rejects unknown signature types and truncated tickets", () => {
    const ticket = buildTicket({ rightsId });
    expectFormatError(() => parseTicket(ticket.subarray(0, ticket.length - 1)), "TRUNCATED");
    ticket.writeUInt32LE(0x20000, 0);
    expectFormatError(() => parseTicket(ticket), "UNSUPPORTED");
  });
});

describe("parseNro", () => {
  it("reads NACP metadata and locates the icon", async () => {
    const icon = fakeJpeg("tool", 0x333);
    const nro = buildNro({ name: "Tool", publisher: "Someone", displayVersion: "1.2.3", icon });
    const info = await parseNro(new BufferReader(nro));
    expect(info.nacp).toEqual({
      name: "Tool",
      publisher: "Someone",
      displayVersion: "1.2.3",
      addOnContentBaseId: "0000000000000000",
    });
    expect(info.icon).not.toBeNull();
    expect(nro.subarray(info.icon!.offset, info.icon!.offset + info.icon!.size)).toEqual(icon);
    expect(info.romfs).toBeNull();
  });

  it("handles NROs without assets or without an icon", async () => {
    const bare = await parseNro(
      new BufferReader(
        buildNro({ name: "x", publisher: "", displayVersion: "", withoutAssets: true }),
      ),
    );
    expect(bare).toMatchObject({ icon: null, nacp: null });

    const iconless = await parseNro(
      new BufferReader(buildNro({ name: "x", publisher: "", displayVersion: "0.1", icon: null })),
    );
    expect(iconless.icon).toBeNull();
    expect(iconless.nacp?.displayVersion).toBe("0.1");
  });

  it("rejects non-NRO data and truncated assets", async () => {
    await expectAsyncFormatError(parseNro(new BufferReader(Buffer.alloc(0x100))), "BAD_MAGIC");
    const nro = buildNro({ name: "Tool", publisher: "", displayVersion: "" });
    await expectAsyncFormatError(
      parseNro(new BufferReader(nro.subarray(0, nro.length - 1))),
      "TRUNCATED",
    );
  });
});
