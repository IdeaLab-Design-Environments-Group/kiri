import { describe, expect, it } from "vitest";
import { createZip, type ZipEntry } from "@kirigami/model/zip.js";

const u32 = (b: Uint8Array, o: number): number =>
  (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const u16 = (b: Uint8Array, o: number): number => b[o] | (b[o + 1] << 8);

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;

/** Parse the STORE-method archive back into {name, crc, data} by walking local headers. */
function readZip(buf: Uint8Array): { name: string; crc: number; data: Uint8Array }[] {
  const dec = new TextDecoder();
  const out: { name: string; crc: number; data: Uint8Array }[] = [];
  let p = 0;
  while (p + 4 <= buf.length && u32(buf, p) === LOCAL_SIG) {
    const crc = u32(buf, p + 14);
    const compSize = u32(buf, p + 18);
    const nameLen = u16(buf, p + 26);
    const extraLen = u16(buf, p + 28);
    const nameStart = p + 30;
    const dataStart = nameStart + nameLen + extraLen;
    out.push({
      name: dec.decode(buf.slice(nameStart, nameStart + nameLen)),
      crc,
      data: buf.slice(dataStart, dataStart + compSize),
    });
    p = dataStart + compSize;
  }
  return out;
}

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

describe("createZip", () => {
  it("an empty archive is just a 22-byte end-of-central-directory record", () => {
    const z = createZip([]);
    expect(z.length).toBe(22);
    expect(u32(z, 0)).toBe(EOCD_SIG);
    expect(u16(z, 8)).toBe(0); // entries on this disk
    expect(u16(z, 10)).toBe(0); // total entries
  });

  it("writes the three PK signatures and a correct CRC-32 (ISO test vector)", () => {
    // CRC-32 of "123456789" is the standard 0xCBF43926 check value.
    const z = createZip([{ name: "a.txt", data: enc("123456789") }]);
    expect(u32(z, 0)).toBe(LOCAL_SIG);
    expect(u32(z, 14)).toBe(0xcbf43926); // CRC in the local header
    expect(u32(z, z.length - 22)).toBe(EOCD_SIG);
    // STORE method ⇒ compressed size == uncompressed size == 9
    expect(u32(z, 18)).toBe(9);
    expect(u32(z, 22)).toBe(9);
  });

  it("round-trips multiple entries with their folder paths and bytes intact", () => {
    const entries: ZipEntry[] = [
      { name: "akde/akde-cut.svg", data: enc("<svg>cut</svg>") },
      { name: "akde/akde-score.svg", data: enc("<svg>score</svg>") },
    ];
    const parsed = readZip(createZip(entries));

    expect(parsed.map((e) => e.name)).toEqual([
      "akde/akde-cut.svg",
      "akde/akde-score.svg",
    ]);
    expect(new TextDecoder().decode(parsed[0].data)).toBe("<svg>cut</svg>");
    expect(new TextDecoder().decode(parsed[1].data)).toBe("<svg>score</svg>");
  });

  it("preserves arbitrary binary bytes verbatim (not just text)", () => {
    const data = new Uint8Array([0x00, 0xff, 0x10, 0x7f, 0x80, 0xab]);
    const [entry] = readZip(createZip([{ name: "b.bin", data }]));
    expect(Array.from(entry.data)).toEqual(Array.from(data));
  });

  it("central directory count and EOCD offsets are consistent", () => {
    const z = createZip([
      { name: "x", data: enc("xx") },
      { name: "yy", data: enc("yyyy") },
    ]);
    // EOCD: 2 total entries
    const eocd = z.length - 22;
    expect(u16(z, eocd + 10)).toBe(2);
    const centralSize = u32(z, eocd + 12);
    const centralOffset = u32(z, eocd + 16);
    // the central directory begins right where local data ends and has the central signature
    expect(u32(z, centralOffset)).toBe(CENTRAL_SIG);
    // central dir + EOCD fill the rest of the file
    expect(centralOffset + centralSize + 22).toBe(z.length);
  });
});
