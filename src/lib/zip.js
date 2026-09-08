/* Dependency-free ZIP reader/writer.
 *
 * Every Office format (xlsx, docx, pptx) is a ZIP of XML parts, so reading and
 * writing them needs nothing more than this plus string handling. Only Web APIs
 * that workerd provides are used: Compression/DecompressionStream('deflate-raw'),
 * TextEncoder/TextDecoder and DataView. */

const te = new TextEncoder();

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function deflateRaw(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function inflateRaw(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Builds a ZIP archive.
 * @param {{name: string, data: string|Uint8Array}[]} entries
 * @returns {Promise<Uint8Array>}
 */
export async function zip(entries) {
  const locals = [];
  const central = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = te.encode(entry.name);
    const raw = typeof entry.data === 'string' ? te.encode(entry.data) : entry.data;
    const packed = raw.length > 64 ? await deflateRaw(raw) : raw;
    // Storing beats deflating for tiny or already-compressed parts.
    const deflated = packed.length < raw.length;
    const body = deflated ? packed : raw;
    const method = deflated ? 8 : 0;
    const sum = crc32(raw);

    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(8, method, true);
    lv.setUint16(12, 0x28a1, true); // fixed 2000-01-01 timestamp
    lv.setUint32(14, sum, true);
    lv.setUint32(18, body.length, true);
    lv.setUint32(22, raw.length, true);
    lv.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    locals.push(local, body);

    const dir = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(dir.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(10, method, true);
    cv.setUint16(14, 0x28a1, true);
    cv.setUint32(16, sum, true);
    cv.setUint32(20, body.length, true);
    cv.setUint32(24, raw.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    dir.set(nameBytes, 46);
    central.push(dir);

    offset += local.length + body.length;
  }

  const centralSize = central.reduce((n, b) => n + b.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);

  const out = new Uint8Array(offset + centralSize + 22);
  let p = 0;
  for (const chunk of [...locals, ...central, end]) {
    out.set(chunk, p);
    p += chunk.length;
  }
  return out;
}

/**
 * Reads a ZIP archive by walking its central directory.
 * @returns {Promise<Record<string, Uint8Array>>} entry name -> bytes
 */
export async function unzip(buf, { maxEntries = 2000 } = {}) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder();

  // The end-of-central-directory record sits in the last 64KB, after a comment
  // of unknown length, so it has to be scanned for backwards.
  let eocd = -1;
  const floor = Math.max(0, bytes.length - 65558);
  for (let i = bytes.length - 22; i >= floor; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('ZIP形式ではありません');

  const count = Math.min(dv.getUint16(eocd + 10, true), maxEntries);
  let p = dv.getUint32(eocd + 16, true);
  const files = {};

  for (let i = 0; i < count; i++) {
    if (p + 46 > bytes.length || dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true);
    const compSize = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const localOff = dv.getUint32(p + 42, true);
    const name = decoder.decode(bytes.subarray(p + 46, p + 46 + nameLen));

    if (localOff + 30 <= bytes.length && dv.getUint32(localOff, true) === 0x04034b50) {
      const start = localOff + 30 + dv.getUint16(localOff + 26, true) + dv.getUint16(localOff + 28, true);
      const body = bytes.subarray(start, start + compSize);
      try {
        files[name] = method === 8 ? await inflateRaw(body) : body;
      } catch {
        /* a single unreadable part should not sink the whole document */
      }
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

export const isZip = (bytes) => bytes?.length > 3 && bytes[0] === 0x50 && bytes[1] === 0x4b;
