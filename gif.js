// gif.js - a small animated-GIF encoder (GIF89a, one shared 256-color palette).
// encodeGif(frames, width, height) -> Uint8Array
//   frames: [{ rgba: Uint8ClampedArray(width*height*4), delay: milliseconds }]

export function encodeGif(frames, width, height) {
  const palette = medianCutPalette(frames, 256);
  const lut = new Int16Array(32768).fill(-1); // 5-bit RGB -> palette index
  const out = new ByteWriter();
  out.str("GIF89a");
  out.u16(width); out.u16(height);
  out.u8(0xf7); out.u8(0); out.u8(0); // global color table, 256 entries
  for (let i = 0; i < 256; i++) out.u8(palette[i * 3]), out.u8(palette[i * 3 + 1]), out.u8(palette[i * 3 + 2]);
  out.u8(0x21); out.u8(0xff); out.u8(11); out.str("NETSCAPE2.0"); out.u8(3); out.u8(1); out.u16(0); out.u8(0); // loop forever
  const idx = new Uint8Array(width * height);
  for (const f of frames) {
    const px = f.rgba;
    for (let p = 0, q = 0; p < idx.length; p++, q += 4) {
      const key = ((px[q] >> 3) << 10) | ((px[q + 1] >> 3) << 5) | (px[q + 2] >> 3);
      let c = lut[key];
      if (c < 0) c = lut[key] = nearest(palette, (px[q] & 0xf8) | 4, (px[q + 1] & 0xf8) | 4, (px[q + 2] & 0xf8) | 4);
      idx[p] = c;
    }
    out.u8(0x21); out.u8(0xf9); out.u8(4); out.u8(0x04); // graphic control: keep previous frame
    out.u16(Math.max(2, Math.round(f.delay / 10))); out.u8(0); out.u8(0);
    out.u8(0x2c); out.u16(0); out.u16(0); out.u16(width); out.u16(height); out.u8(0);
    out.u8(8);
    lzw(idx, out);
  }
  out.u8(0x3b);
  return out.bytes();
}

class ByteWriter {
  constructor() { this.buf = new Uint8Array(1 << 20); this.n = 0; }
  grow(k) {
    if (this.n + k <= this.buf.length) return;
    const b = new Uint8Array(Math.max(this.buf.length * 2, this.n + k));
    b.set(this.buf.subarray(0, this.n));
    this.buf = b;
  }
  u8(v) { this.grow(1); this.buf[this.n++] = v & 255; }
  u16(v) { this.u8(v); this.u8(v >> 8); }
  str(s) { for (const ch of s) this.u8(ch.charCodeAt(0)); }
  bytes() { return this.buf.slice(0, this.n); }
}

function nearest(pal, r, g, b) {
  let best = 0, bd = Infinity;
  for (let i = 0; i < 256; i++) {
    const dr = pal[i * 3] - r, dg = pal[i * 3 + 1] - g, db = pal[i * 3 + 2] - b;
    const d = 2 * dr * dr + 4 * dg * dg + 3 * db * db;
    if (d < bd) { bd = d; best = i; }
  }
  return best;
}

// Median cut over a sample of pixels from every frame.
function medianCutPalette(frames, size) {
  const total = frames.reduce((a, f) => a + f.rgba.length / 4, 0);
  const step = Math.max(1, Math.floor(total / 80000));
  const pts = [];
  let k = 0;
  for (const f of frames) {
    for (let q = 0; q < f.rgba.length; q += 4, k++) if (k % step === 0) pts.push((f.rgba[q] << 16) | (f.rgba[q + 1] << 8) | f.rgba[q + 2]);
  }
  let boxes = [Int32Array.from(pts)];
  const ch = (v, c) => (v >> (16 - 8 * c)) & 255;
  while (boxes.length < size) {
    let bi = -1, bestRange = 0, bestC = 0;
    boxes.forEach((b, i) => {
      if (b.length < 2) return;
      for (let c = 0; c < 3; c++) {
        let lo = 255, hi = 0;
        for (const v of b) { const x = ch(v, c); if (x < lo) lo = x; if (x > hi) hi = x; }
        if (hi - lo > bestRange) { bestRange = hi - lo; bi = i; bestC = c; }
      }
    });
    if (bi < 0) break;
    const b = boxes[bi].sort((x, y) => ch(x, bestC) - ch(y, bestC));
    const mid = b.length >> 1;
    boxes.splice(bi, 1, b.slice(0, mid), b.slice(mid));
  }
  const pal = new Uint8Array(size * 3);
  boxes.forEach((b, i) => {
    let r = 0, g = 0, bl = 0;
    for (const v of b) { r += ch(v, 0); g += ch(v, 1); bl += ch(v, 2); }
    const n = Math.max(1, b.length);
    pal[i * 3] = Math.round(r / n); pal[i * 3 + 1] = Math.round(g / n); pal[i * 3 + 2] = Math.round(bl / n);
  });
  return pal;
}

// GIF LZW with 8-bit minimum code size, written as 255-byte sub-blocks.
const table = new Int16Array(1 << 20);
function lzw(indices, out) {
  const clear = 256, eoi = 257, data = [];
  let size = 9, next = 258, cur = 0, shift = 0;
  const emit = (code) => {
    cur |= code << shift;
    shift += size;
    while (shift >= 8) { data.push(cur & 255); cur >>>= 8; shift -= 8; }
  };
  table.fill(0);
  emit(clear);
  let prefix = indices[0];
  for (let i = 1; i < indices.length; i++) {
    const k = indices[i], key = (prefix << 8) | k, hit = table[key];
    if (hit) { prefix = hit - 1; continue; }
    emit(prefix);
    if (next === 4096) {
      emit(clear);
      table.fill(0);
      size = 9;
      next = 258;
    } else {
      if (next >= 1 << size) size++;
      table[key] = next++ + 1;
    }
    prefix = k;
  }
  emit(prefix);
  emit(eoi);
  if (shift > 0) data.push(cur & 255);
  for (let i = 0; i < data.length; i += 255) {
    const n = Math.min(255, data.length - i);
    out.u8(n);
    out.grow(n);
    for (let j = 0; j < n; j++) out.buf[out.n++] = data[i + j];
  }
  out.u8(0);
}
