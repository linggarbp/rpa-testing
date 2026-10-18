/**
 * A minimal PNG writer over the stdlib — enough for a screenshot.
 *
 * robot.js hands back raw BGRA pixels; every backend's `capture` owes the caller a file path, and
 * a PNG is what the rest of the toolkit (and any image viewer) expects. Deflate comes from
 * `node:zlib`, so this is ~60 lines rather than an image dependency.
 */
import { deflateSync } from 'node:zlib';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer: Buffer): number {
  let crc = -1;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

export interface PngOptions {
  /** Bytes per pixel in the source rows. 4 = BGRA (robot.js), 3 = BGR. Default 4. */
  channels?: 3 | 4;
  /** Row length in bytes when the source is padded (a captured sub-rectangle). Defaults to width. */
  stride?: number;
}

/** Encode BGRA/BGR rows as an 8-bit RGBA PNG. */
export function encodePng(width: number, height: number, pixels: Buffer, options: PngOptions = {}): Buffer {
  const channels = options.channels ?? 4;
  const stride = options.stride ?? width * channels;
  if (pixels.length < stride * height) {
    throw new Error(`encodePng needs ${stride * height} bytes for ${width}x${height} at ${channels} channels, got ${pixels.length}`);
  }

  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y += 1) {
    let out = y * (1 + width * 4);
    raw[out] = 0; // filter: none
    out += 1;
    const row = y * stride;
    for (let x = 0; x < width; x += 1) {
      const at = row + x * channels;
      raw[out] = pixels[at + 2] ?? 0; // R (source is BGR order)
      raw[out + 1] = pixels[at + 1] ?? 0; // G
      raw[out + 2] = pixels[at] ?? 0; // B
      raw[out + 3] = channels === 4 ? pixels[at + 3] ?? 255 : 255;
      out += 4;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: truecolour with alpha
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter method
  ihdr[12] = 0; // no interlace

  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ]);
}
