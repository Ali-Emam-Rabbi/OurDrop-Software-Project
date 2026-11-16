// Incremental SHA-256 (FIPS 180-4) for hashing Files chunk by chunk,
// so even large files can be verified without loading them into memory.
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

export class Sha256 {
  private h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  private buf = new Uint8Array(64);
  private bufLen = 0;
  private total = 0;
  private w = new Uint32Array(64);

  update(data: Uint8Array) {
    this.total += data.length;
    let off = 0;
    if (this.bufLen) {
      const take = Math.min(64 - this.bufLen, data.length);
      this.buf.set(data.subarray(0, take), this.bufLen);
      this.bufLen += take;
      off += take;
      if (this.bufLen === 64) {
        this.block(this.buf, 0);
        this.bufLen = 0;
      }
    }
    while (off + 64 <= data.length) {
      this.block(data, off);
      off += 64;
    }
    if (off < data.length) {
      this.buf.set(data.subarray(off), 0);
      this.bufLen = data.length - off;
    }
  }

  private block(b: Uint8Array, off: number) {
    const w = this.w;
    for (let i = 0; i < 16; i++) {
      w[i] = (b[off + i * 4] << 24) | (b[off + i * 4 + 1] << 16) | (b[off + i * 4 + 2] << 8) | b[off + i * 4 + 3];
    }
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    let [a, b1, c, d, e, f, g, h] = this.h;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[i] + w[i]) | 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b1) ^ (a & c) ^ (b1 & c);
      const t2 = (S0 + maj) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0;
      d = c; c = b1; b1 = a; a = (t1 + t2) | 0;
    }
    const hs = [a, b1, c, d, e, f, g, h];
    for (let i = 0; i < 8; i++) this.h[i] = (this.h[i] + hs[i]) | 0;
  }

  digestHex(): string {
    const bitLenHi = Math.floor(this.total / 0x20000000);
    const bitLenLo = (this.total << 3) >>> 0;
    const pad = new Uint8Array(72);
    pad[0] = 0x80;
    const padLen = this.bufLen < 56 ? 56 - this.bufLen : 120 - this.bufLen;
    const tail = new Uint8Array(padLen + 8);
    tail.set(pad.subarray(0, padLen));
    const dv = new DataView(tail.buffer);
    dv.setUint32(padLen, bitLenHi);
    dv.setUint32(padLen + 4, bitLenLo);
    // process tail against a copy of the state (digest is terminal anyway)
    const savedTotal = this.total;
    this.update(tail);
    this.total = savedTotal;
    let out = "";
    for (let i = 0; i < 8; i++) out += (this.h[i] >>> 0).toString(16).padStart(8, "0");
    return out;
  }
}

function rotr(x: number, n: number) {
  return (x >>> n) | (x << (32 - n));
}

/** Hash a File/Blob in slices; returns lowercase hex. */
export async function sha256OfBlob(blob: Blob, sliceSize = 1024 * 1024): Promise<string> {
  const h = new Sha256();
  for (let off = 0; off < blob.size; off += sliceSize) {
    const part = await blob.slice(off, off + sliceSize).arrayBuffer();
    h.update(new Uint8Array(part));
  }
  if (blob.size === 0) h.update(new Uint8Array(0));
  return h.digestHex();
}
