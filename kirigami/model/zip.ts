/**
 * Minimal, dependency-free ZIP writer (STORE / no compression). Enough to bundle a few
 * small text files (e.g. the cut + score SVGs) into one archive with a folder structure,
 * so a browser download delivers them inside a single folder. Pure: returns the archive
 * bytes; the caller wraps them in a Blob to download.
 */

export interface ZipEntry {
  /** Path inside the archive, e.g. "folder/file.svg". */
  name: string;
  data: Uint8Array;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

export function createZip(entries: ZipEntry[]): Uint8Array {
  const enc = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = enc.encode(entry.name);
    const crc = crc32(entry.data);
    const size = entry.data.length;

    const local = new Uint8Array(30 + nameBytes.length);
    const ldv = new DataView(local.buffer);
    ldv.setUint32(0, 0x04034b50, true); // local file header signature
    ldv.setUint16(4, 20, true); // version needed
    ldv.setUint16(6, 0, true); // flags
    ldv.setUint16(8, 0, true); // method: store
    ldv.setUint16(10, 0, true); // mod time
    ldv.setUint16(12, 0, true); // mod date
    ldv.setUint32(14, crc, true);
    ldv.setUint32(18, size, true); // compressed size
    ldv.setUint32(22, size, true); // uncompressed size
    ldv.setUint16(26, nameBytes.length, true);
    ldv.setUint16(28, 0, true); // extra length
    local.set(nameBytes, 30);
    locals.push(local, entry.data);

    const central = new Uint8Array(46 + nameBytes.length);
    const cdv = new DataView(central.buffer);
    cdv.setUint32(0, 0x02014b50, true); // central directory signature
    cdv.setUint16(4, 20, true); // version made by
    cdv.setUint16(6, 20, true); // version needed
    cdv.setUint16(8, 0, true); // flags
    cdv.setUint16(10, 0, true); // method
    cdv.setUint16(12, 0, true); // time
    cdv.setUint16(14, 0, true); // date
    cdv.setUint32(16, crc, true);
    cdv.setUint32(20, size, true);
    cdv.setUint32(24, size, true);
    cdv.setUint16(28, nameBytes.length, true);
    cdv.setUint16(30, 0, true); // extra
    cdv.setUint16(32, 0, true); // comment
    cdv.setUint16(34, 0, true); // disk number
    cdv.setUint16(36, 0, true); // internal attrs
    cdv.setUint32(38, 0, true); // external attrs
    cdv.setUint32(42, offset, true); // local header offset
    central.set(nameBytes, 46);
    centrals.push(central);

    offset += local.length + size;
  }

  const centralSize = centrals.reduce((a, c) => a + c.length, 0);
  const centralOffset = offset;

  const end = new Uint8Array(22);
  const edv = new DataView(end.buffer);
  edv.setUint32(0, 0x06054b50, true); // end of central directory signature
  edv.setUint16(4, 0, true); // disk number
  edv.setUint16(6, 0, true); // disk with central dir
  edv.setUint16(8, entries.length, true); // entries on this disk
  edv.setUint16(10, entries.length, true); // total entries
  edv.setUint32(12, centralSize, true);
  edv.setUint32(16, centralOffset, true);
  edv.setUint16(20, 0, true); // comment length

  const parts = [...locals, ...centrals, end];
  const total = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(total);
  let p = 0;
  for (const part of parts) {
    out.set(part, p);
    p += part.length;
  }
  return out;
}
