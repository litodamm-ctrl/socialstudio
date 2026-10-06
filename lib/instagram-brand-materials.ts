import type { ReferenceUsage } from "@/lib/reference-usage";
import { decryptInstagramToken, graphUrl } from "@/lib/meta";
import { fetchPublicResource } from "@/lib/website-sources";
import { rotateReferences } from "@/lib/creative-references";
import sharp from "sharp";

type Media = { id?: string; caption?: string; media_type?: string; media_url?: string; timestamp?: string; children?: { data?: Media[] } };
export async function loadInstagramBrandMaterials(db: D1Database, owner: string, brand: string, seed: string, usage?: ReferenceUsage) {
  const account = await db.prepare("SELECT instagram_user_id, username, encrypted_token FROM instagram_accounts WHERE owner_id = ? AND brand = ?")
    .bind(owner, brand).first<{instagram_user_id:string; username:string; encrypted_token:string}>();
  if (!account) throw new Error("Conecta Instagram para consultar las referencias de esta marca.");
  const token = await decryptInstagramToken(account.encrypted_token);
  const url = new URL(graphUrl(`${encodeURIComponent(account.instagram_user_id)}/media`));
  url.searchParams.set("fields", "id,caption,media_type,media_url,timestamp,children{id,media_type,media_url}");
  url.searchParams.set("limit", "24");
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000), cache: "no-store" });
  if (!response.ok) throw new Error("Instagram no permitió leer las publicaciones. Revisa la conexión y el permiso de lectura de la cuenta.");
  const result = await response.json() as { data?: Media[]; error?: unknown };
  if (result.error || !Array.isArray(result.data)) throw new Error("Instagram no devolvió referencias válidas.");
  const candidates = result.data.flatMap(post => {
    const images = post.media_type === "CAROUSEL_ALBUM" ? post.children?.data ?? [] : [post];
    return images.filter(image => image.media_type === "IMAGE" && image.media_url).slice(0, 2).map(image => ({ key: `instagram:${image.id ?? post.id}`, url: image.media_url!, caption: post.caption?.slice(0, 1000) ?? "", date: post.timestamp ?? "" }));
  });
  const content: Array<Record<string, string>> = [];
  for (const item of (usage ? usage.rank(candidates, item => item.key).slice(0, 8) : rotateReferences(candidates, seed, 6))) {
    if (content.filter(part => part.type === "input_image").length >= 3) break;
    try {
      const file = await fetchPublicResource(item.url, 5 * 1024 * 1024);
      if (!["image/jpeg", "image/png", "image/webp"].includes(file.contentType)) continue;
      const decoder = sharp(file.bytes, { limitInputPixels: 20_000_000 });
      const meta = await decoder.metadata();
      if ((meta.width ?? 0) < 300 || (meta.height ?? 0) < 200) continue;
      const bytes = await decoder.rotate().resize(1400, 1400, { fit: "inside", withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();
      usage?.mark(item.key);
      content.push({type:"input_text", text:`Referencia histórica de @${account.username}, ${item.date}. Texto original (no acredita vigencia, stock ni precio): ${item.caption}`});
      content.push({type:"input_image",image_url:`data:image/jpeg;base64,${bytes.toString("base64")}`,detail:"high"});
    } catch { /* No substitute with an unrelated account or image. */ }
  }
  if (!content.some(part => part.type === "input_image")) throw new Error("No se encontraron fotografías descargables en las últimas 24 publicaciones. Carga fotos y publicaciones de referencia en Recursos de marca o Drive.");
  return { username: account.username, postsRead: result.data.length, content,
    text: result.data.slice(0, 12).map(post => `${post.timestamp ?? ""}: ${post.caption?.slice(0, 600) ?? ""}`).join("\n") };
}
