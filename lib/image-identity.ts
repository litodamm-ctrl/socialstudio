import sharp from "sharp";
import { createHash } from "node:crypto";

// Normalize resolution, orientation, metadata and encoding before hashing.
export async function imageIdentity(bytes: Uint8Array) {
  const pixels = await sharp(bytes,{limitInputPixels:25_000_000}).rotate()
    .resize(64,64,{fit:"fill"}).removeAlpha().toColourspace("srgb").raw().toBuffer();
  return createHash("sha256").update(pixels).digest("hex");
}
