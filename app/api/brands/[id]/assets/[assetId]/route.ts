import { normalizeWebsiteUrls } from "@/lib/website-sources";
import { env } from "@/lib/runtime";
import { ensureDefaultBrands } from "@/lib/brands";

export async function DELETE(request: Request, context: { params: Promise<{ id: string; assetId: string }> }) {
  const ownerId = request.headers.get("oai-authenticated-user-id");
  if (!ownerId) return Response.json({ error: "Inicia sesión para quitar el recurso." }, { status: 401 });
  if (!env.DB || !env.BUCKET) return Response.json({ error: "La biblioteca de marca no está disponible." }, { status: 503 });
  const { id, assetId } = await context.params;
  try {
    await ensureDefaultBrands(env.DB, ownerId);
    const asset = await env.DB.prepare("SELECT object_key FROM brand_assets WHERE id = ? AND owner_id = ? AND brand_id = ?")
      .bind(assetId, ownerId, id).first<{ object_key: string }>();
    if (!asset) return Response.json({ error: "El recurso ya no existe." }, { status: 404 });
    await env.BUCKET.delete(asset.object_key);
    await env.DB.prepare("DELETE FROM brand_assets WHERE id = ? AND owner_id = ? AND brand_id = ?")
      .bind(assetId, ownerId, id).run();
    return Response.json({ deleted: true });
  } catch (error) {
    console.error("Unable to delete brand resource", error instanceof Error ? error.message : "unknown error");
    return Response.json({ error: "No se pudo quitar el recurso." }, { status: 503 });
  }
}

export async function POST(request: Request, context: { params: Promise<{ id: string; assetId: string }> }) {
  const ownerId = request.headers.get("oai-authenticated-user-id");
  if (!ownerId) return Response.json({ error: "Inicia sesión para agregar el recurso." }, { status: 401 });
  if (!env.DB || !env.BUCKET) return Response.json({ error: "La biblioteca de marca no está disponible." }, { status: 503 });
  const { id: brandId, assetId } = await context.params;
  if (!/^[0-9a-f-]{36}$/i.test(assetId)) return Response.json({ error: "El recurso no es válido." }, { status: 400 });
  try {
    await ensureDefaultBrands(env.DB, ownerId);
    const brand = await env.DB.prepare("SELECT id FROM brand_registry WHERE id = ? AND owner_id = ? AND active = 1").bind(brandId, ownerId).first<{ id: string }>();
    if (!brand) return Response.json({ error: "La marca no existe o está archivada." }, { status: 404 });
    const input = await request.json() as { name?: unknown; contentType?: unknown; size?: unknown; objectKey?: unknown; sourceUrl?: unknown };
    const name = typeof input.name === "string" ? input.name.trim().slice(0, 180) : "";
    const contentType = typeof input.contentType === "string" ? input.contentType : "";
    const size = Number(input.size);
    const sourceUrl = typeof input.sourceUrl === "string" && input.sourceUrl.trim() ? normalizeWebsiteUrls([input.sourceUrl])[0] : "";
    const objectKey = `brand-assets/${ownerId}/${brandId}/${assetId}`;
    if (!name || input.objectKey !== objectKey || !Number.isSafeInteger(size) || size < 1 || size > 15 * 1024 * 1024) return Response.json({ error: "Los datos del recurso no son válidos." }, { status: 400 });
    const object = await env.BUCKET.head(objectKey);
    if (!object || object.customMetadata?.ownerId !== ownerId || object.customMetadata?.brandId !== brandId || object.httpMetadata?.contentType !== contentType || object.size !== size) return Response.json({ error: "La carga del archivo no terminó correctamente." }, { status: 409 });
    const duplicate = await env.DB.prepare("SELECT id FROM brand_assets WHERE id = ? AND owner_id = ? AND brand_id = ?").bind(assetId, ownerId, brandId).first<{ id: string }>();
    if (duplicate) return Response.json({ error: "El recurso ya fue agregado." }, { status: 409 });
    await env.DB.prepare("INSERT INTO brand_assets (id, owner_id, brand_id, name, content_type, object_key, file_size, created_at, source_url) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(assetId, ownerId, brandId, name, contentType, objectKey, size, Date.now(), sourceUrl).run();
    return Response.json({ asset: { id: assetId, name, contentType, size, sourceUrl, createdAt: Date.now() } }, { status: 201 });
  } catch (error) {
    console.error("Unable to finalize direct brand asset upload", error instanceof Error ? error.message : "unknown error");
    return Response.json({ error: "No se pudo registrar el recurso." }, { status: 503 });
  }
}

