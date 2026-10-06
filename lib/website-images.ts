import sharp from "sharp";
import { fetchPublicResource } from "@/lib/website-sources";
export async function readWebsiteImage(source: string): Promise<Buffer> {
  const limit = 5 * 1024 * 1024;
  let bytes: Buffer;
  if (source.startsWith("data:")) {
    if (source.length > 7 * 1024 * 1024 || !/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/i.test(source)) throw new Error("Formato de imagen incrustada no admitido.");
    bytes = Buffer.from(source.slice(source.indexOf(",") + 1), "base64");
    if (!bytes.length || bytes.length > limit) throw new Error("Imagen incrustada demasiado grande.");
  } else {
    const resource = await fetchPublicResource(source, limit);
    if (!["image/jpeg", "image/png", "image/webp"].includes(resource.contentType)) throw new Error("El recurso no es una fotografía admitida.");
    bytes = resource.bytes;
  }
  const decoder = sharp(bytes, {limitInputPixels:20_000_000});
  const metadata = await decoder.metadata();
  if (!["jpeg","png","webp"].includes(metadata.format ?? "") || (metadata.width ?? 0) < 300 || (metadata.height ?? 0) < 200) throw new Error("Imagen pequeña o formato no válido.");
  return decoder.rotate().resize(1600,1600,{fit:"inside",withoutEnlargement:true}).jpeg({quality:85}).toBuffer();
}
