import { PNG } from "pngjs";
import { inflateSync } from "node:zlib";
import {
  AVATAR_SIZE,
  AVATAR_MAX_UPLOAD_BYTES,
} from "../../../shared/social.ts";
import { AuthError } from "../auth/types.ts";
const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
/** Canonicalize a bounded, non-interlaced canvas PNG; never store source metadata. */
export function normalizeAvatar(input: Buffer): Buffer {
  try {
    if (
      !Buffer.isBuffer(input) ||
      input.length < 57 ||
      input.length > AVATAR_MAX_UPLOAD_BYTES ||
      !input.subarray(0, 8).equals(signature)
    )
      throw Error();
    if (
      input.readUInt32BE(8) !== 13 ||
      input.toString("ascii", 12, 16) !== "IHDR" ||
      input.readUInt32BE(16) !== AVATAR_SIZE ||
      input.readUInt32BE(20) !== AVATAR_SIZE ||
      input[24] !== 8 ||
      ![2, 6].includes(input[25]) ||
      input[26] !== 0 ||
      input[27] !== 0 ||
      input[28] !== 0
    )
      throw Error();
    let at = 8,
      chunks = 0,
      ended = false;
    const compressed: Buffer[] = [];
    while (at < input.length) {
      if (++chunks > 128 || at + 12 > input.length) throw Error();
      const size = input.readUInt32BE(at),
        end = at + 12 + size;
      if (end > input.length) throw Error();
      const kind = input.toString("ascii", at + 4, at + 8);
      if (
        (kind === "IHDR" && at !== 8) ||
        kind === "acTL" ||
        kind === "fcTL" ||
        kind === "fdAT"
      )
        throw Error();
      if (kind === "IDAT")
        compressed.push(input.subarray(at + 8, at + 8 + size));
      if (kind === "IEND") {
        if (size !== 0 || end !== input.length) throw Error();
        ended = true;
      }
      at = end;
    }
    if (!ended || !compressed.length) throw Error();
    const expected =
      (AVATAR_SIZE * (input[25] === 6 ? 4 : 3) + 1) * AVATAR_SIZE;
    if (
      inflateSync(Buffer.concat(compressed), { maxOutputLength: expected })
        .length !== expected
    )
      throw Error();
    const image = PNG.sync.read(input, { checkCRC: true });
    const canonical = new PNG({ width: AVATAR_SIZE, height: AVATAR_SIZE });
    canonical.data = image.data;
    const clean = PNG.sync.write(canonical, {
      colorType: 6,
      bitDepth: 8,
      deflateLevel: 9,
    });
    if (clean.length > AVATAR_MAX_UPLOAD_BYTES) throw Error();
    return clean;
  } catch {
    throw new AuthError(
      "INVALID_AVATAR_IMAGE",
      "图片无法读取，请重新选择 PNG、JPEG 或 WebP 照片并裁剪",
      400,
    );
  }
}
