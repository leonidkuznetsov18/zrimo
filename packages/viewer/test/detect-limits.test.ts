import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  defaultResourceLimits,
  detectFormat,
  enforceContainerLimits,
  ViewerError,
} from "../src/index.js";

describe("format detection", () => {
  it("lets magic bytes override a mismatched extension", () => {
    const result = detectFormat(new TextEncoder().encode("%PDF-1.7"), {
      fileName: "report.docx",
    });
    assert.equal(result.format, "pdf");
    assert.equal(result.warnings[0]?.code, "format-hint-mismatch");
  });

  it("detects OOXML and legacy OLE families from container entries", () => {
    const zip = new TextEncoder().encode(
      "PK\u0003\u0004 unrelated word/document.xml",
    );
    assert.equal(detectFormat(zip).format, "docx");

    const ole = new Uint8Array(256);
    ole.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    const stream = "Workbook";
    for (let index = 0; index < stream.length; index += 1)
      ole[64 + index * 2] = stream.charCodeAt(index);
    assert.equal(detectFormat(ole).format, "xls");
  });

  it("recognizes SVG and accepts delimited text only with a hint", () => {
    assert.equal(
      detectFormat(new TextEncoder().encode("<?xml version='1.0'?><svg></svg>"))
        .format,
      "svg",
    );
    assert.equal(
      detectFormat(new TextEncoder().encode("a,b\n1,2"), {
        contentType: "text/csv",
      }).format,
      "csv",
    );
    assert.throws(
      () => detectFormat(new TextEncoder().encode("plain text")),
      isCode("unsupported-format"),
    );
  });

  it("routes OOXML by entry names, not by bytes inside compressed parts", () => {
    // Compressed media in a large deck routinely contains a random "xl/" or
    // "word/" byte run; the archive's entry names must win over that noise.
    const poisonedDeck = storedZip([
      { name: "[Content_Types].xml" },
      { name: "ppt/presentation.xml" },
      {
        name: "ppt/media/image1.bin",
        data: new TextEncoder().encode("noise xl/workbook.xml word/ noise"),
      },
    ]);
    assert.equal(detectFormat(poisonedDeck).format, "pptx");
    assert.equal(
      detectFormat(poisonedDeck, { fileName: "deck.pptx" }).format,
      "pptx",
    );

    const workbook = storedZip([{ name: "xl/workbook.xml" }]);
    assert.equal(detectFormat(workbook).format, "xlsx");
  });

  it("falls back to the byte scan when the central directory is missing", () => {
    // sniffFormat callers may pass only a file prefix, which has no
    // end-of-central-directory record.
    const prefix = new TextEncoder().encode(
      "PK truncated ppt/slides/slide1.xml",
    );
    assert.equal(
      detectFormat(prefix, { fileName: "deck.pptx" }).format,
      "pptx",
    );
  });

  it("rejects encrypted OOXML-in-OLE containers before adapter routing", () => {
    const ole = new Uint8Array(512);
    ole.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    writeUtf16(ole, 64, "EncryptionInfo");
    writeUtf16(ole, 160, "EncryptedPackage");
    assert.throws(
      () => detectFormat(ole, { fileName: "protected.docx" }),
      isCode("encrypted-document"),
    );
  });
});

describe("pre-allocation resource limits", () => {
  it("rejects an oversized ZIP entry from the central directory", () => {
    const zip = centralDirectory([65]);
    assert.throws(
      () =>
        enforceContainerLimits(zip, "docx", {
          ...defaultResourceLimits,
          maxZipEntryBytes: 64,
        }),
      isCode("resource-limit"),
    );
  });

  it("rejects aggregate expanded Office size", () => {
    const zip = centralDirectory([60, 60]);
    assert.throws(
      () =>
        enforceContainerLimits(zip, "xlsx", {
          ...defaultResourceLimits,
          maxZipEntryBytes: 100,
          maxExpandedOfficeBytes: 100,
        }),
      isCode("resource-limit"),
    );
  });

  it("rejects excessive decoded image pixels before decode", () => {
    const png = new Uint8Array(24);
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const view = new DataView(png.buffer);
    view.setUint32(16, 20_000);
    view.setUint32(20, 20_000);
    assert.throws(
      () =>
        enforceContainerLimits(png, "png", {
          ...defaultResourceLimits,
          maxDecodedPixels: 100_000_000,
        }),
      isCode("resource-limit"),
    );
  });

  it("rejects oversized SVG before DOM parsing", () => {
    const svg = new TextEncoder().encode(`<svg>${" ".repeat(64)}</svg>`);
    assert.throws(
      () =>
        enforceContainerLimits(svg, "svg", {
          ...defaultResourceLimits,
          maxSvgBytes: 32,
        }),
      isCode("resource-limit"),
    );
  });
});

/** Minimal stored (uncompressed) archive; CRCs stay zero — detection reads names only. */
function storedZip(
  entries: readonly { name: string; data?: Uint8Array }[],
): Uint8Array {
  const encoder = new TextEncoder();
  const bytes: number[] = [];
  const central: number[] = [];
  const u16 = (target: number[], value: number): void => {
    target.push(value & 0xff, (value >> 8) & 0xff);
  };
  const u32 = (target: number[], value: number): void => {
    u16(target, value & 0xffff);
    u16(target, (value >>> 16) & 0xffff);
  };

  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const data = entry.data ?? new Uint8Array(0);
    const local = bytes.length;
    u32(bytes, 0x04034b50);
    u16(bytes, 20);
    u16(bytes, 0);
    u16(bytes, 0);
    u32(bytes, 0);
    u32(bytes, 0);
    u32(bytes, data.length);
    u32(bytes, data.length);
    u16(bytes, name.length);
    u16(bytes, 0);
    bytes.push(...name, ...data);

    u32(central, 0x02014b50);
    u16(central, 20);
    u16(central, 20);
    u16(central, 0);
    u16(central, 0);
    u32(central, 0);
    u32(central, 0);
    u32(central, data.length);
    u32(central, data.length);
    u16(central, name.length);
    u16(central, 0);
    u16(central, 0);
    u16(central, 0);
    u16(central, 0);
    u32(central, 0);
    u32(central, local);
    central.push(...name);
  }

  const centralOffset = bytes.length;
  bytes.push(...central);
  u32(bytes, 0x06054b50);
  u16(bytes, 0);
  u16(bytes, 0);
  u16(bytes, entries.length);
  u16(bytes, entries.length);
  u32(bytes, central.length);
  u32(bytes, centralOffset);
  u16(bytes, 0);
  return new Uint8Array(bytes);
}

function centralDirectory(sizes: readonly number[]): Uint8Array {
  const bytes = new Uint8Array(sizes.length * 46);
  const view = new DataView(bytes.buffer);
  sizes.forEach((size, index) => {
    const offset = index * 46;
    view.setUint32(offset, 0x02014b50, true);
    view.setUint32(offset + 24, size, true);
  });
  return bytes;
}

function writeUtf16(target: Uint8Array, offset: number, value: string): void {
  for (let index = 0; index < value.length; index += 1)
    target[offset + index * 2] = value.charCodeAt(index);
}

function isCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof ViewerError && error.code === code;
}
