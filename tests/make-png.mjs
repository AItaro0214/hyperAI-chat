// A small PNG encoder, used only to produce a presentable placeholder photo for
// the sample deck. PNG's IDAT is zlib, which CompressionStream('deflate') emits.
import { crc32 } from '../src/lib/zip.js';

const be32 = (n) => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n >>> 0);
  return b;
};

function chunk(type, data) {
  const name = new TextEncoder().encode(type);
  const body = new Uint8Array(name.length + data.length);
  body.set(name, 0);
  body.set(data, name.length);
  const out = new Uint8Array(4 + body.length + 4);
  out.set(be32(data.length), 0);
  out.set(body, 4);
  out.set(be32(crc32(body)), 4 + body.length);
  return out;
}

/** @param {(x:number,y:number)=>[number,number,number]} shade */
export async function makePng(width, height, shade) {
  const raw = new Uint8Array(height * (1 + width * 3));
  let p = 0;
  for (let y = 0; y < height; y++) {
    raw[p++] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const [r, g, b] = shade(x / (width - 1), y / (height - 1));
      raw[p++] = r;
      raw[p++] = g;
      raw[p++] = b;
    }
  }
  const stream = new Blob([raw]).stream().pipeThrough(new CompressionStream('deflate'));
  const idat = new Uint8Array(await new Response(stream).arrayBuffer());

  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width);
  dv.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour

  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', new Uint8Array(0)),
  ];
  const total = parts.reduce((n, b) => n + b.length, 0);
  const out = new Uint8Array(total);
  let q = 0;
  for (const b of parts) {
    out.set(b, q);
    q += b.length;
  }
  return out;
}

/** A soft dusk-over-buildings gradient — enough to stand in for a photo. */
export const placeholderPhoto = (w = 960, h = 540) =>
  makePng(w, h, (u, v) => {
    const sky = [
      Math.round(96 + 120 * (1 - v) + 40 * u),
      Math.round(112 + 90 * (1 - v)),
      Math.round(190 + 55 * (1 - v)),
    ];
    // A skyline silhouette across the lower third.
    const bar = Math.floor(u * 14);
    const height = 0.62 + 0.22 * Math.abs(Math.sin(bar * 2.399));
    if (v > height) {
      const k = (v - height) / (1 - height);
      return [Math.round(38 + 24 * k), Math.round(44 + 26 * k), Math.round(78 + 34 * k)];
    }
    return sky;
  });
