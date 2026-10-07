import sharp from "sharp";

// Preserve the entire creative; only its backdrop is cropped and blurred.
export async function formatStory(input: Uint8Array, legacy = false) {
  let source = await sharp(input, { limitInputPixels: 25_000_000 }).rotate().toBuffer();
  const meta = await sharp(source).metadata();
  // Exact geometry produced by the former 1024x1536 -> contain pipeline.
  if (legacy) {
    if (meta.width !== 1080 || meta.height !== 1920) throw new Error("Unexpected legacy story dimensions");
    source = await sharp(source).extract({ left: 0, top: 150, width: 1080, height: 1620 }).toBuffer();
  }
  const foreground = await sharp(source).resize(1080, 1920, { fit: "inside" }).png().toBuffer();
  const dimensions = await sharp(foreground).metadata();
  const backdrop = await sharp(source).resize(1080, 1920, { fit: "cover" }).blur(45).toBuffer();
  return sharp(backdrop).composite([{ input: foreground,
    left: Math.floor((1080 - dimensions.width!) / 2), top: Math.floor((1920 - dimensions.height!) / 2),
  }]).flatten({ background: "#ffffff" }).jpeg({ quality: 90 }).toBuffer();
}
