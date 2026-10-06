import { env } from "@/lib/runtime";
import { ensureDefaultBrands } from "@/lib/brands";

const MAX_FILE_SIZE = 15 * 1024 * 1024;
const ALLOWED_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "application/pdf", "text/plain", "text/markdown"]);

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const ownerId = request.headers.get("oai-authenticated-user-id");
  if (!ownerId) return Response.json({ error: "Inicia sesión para ver los recursos de marca." }, { status: 401 });
  if (!env.DB) return Response.json({ error: "La biblioteca de marca no está disponible." }, { status: 503 });
  const { id } = await context.params;
  try {
    await ensureDefaultBrands(env.DB, ownerId);
    const brand = await env.DB.prepare("SELECT id FROM brand_registry WHERE id = ? AND owner_id = ?")
      .bind(id, ownerId).first<{ id: string }>();
    if (!brand) return Response.json({ error: "La marca no existe." }, { status: 404 });
    const result = await env.DB.prepare("SELECT id, name, source_url AS sourceUrl, content_type AS contentType, file_size AS size, created_at AS createdAt FROM brand_assets WHERE owner_id = ? AND brand_id = ? ORDER BY created_at DESC")
      .bind(ownerId, id).all<{ id: string; name: string; contentType: string; size: number; createdAt: number }>();
    return Response.json({ assets: result.results ?? [] });
  } catch (error) {
    console.error("Unable to list brand resources", error instanceof Error ? error.message : "unknown error");
    return Response.json({ error: "No se pudieron cargar los recursos." }, { status: 503 });
  }
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const ownerId = request.headers.get("oai-authenticated-user-id");
  if (!ownerId) return Response.json({ error: "Inicia sesión para agregar recursos de marca." }, { status: 401 });
  if (!env.DB || !env.BUCKET) return Response.json({ error: "La biblioteca de marca no está disponible." }, { status: 503 });
  const { id } = await context.params;
  try {
    await ensureDefaultBrands(env.DB, ownerId);
    const brand = await env.DB.prepare("SELECT id FROM brand_registry WHERE id = ? AND owner_id = ?")
      .bind(id, ownerId).first<{ id: string }>();
    if (!brand) return Response.json({ error: "La marca no existe." }, { status: 404 });
    const form = await request.formData();
    const value = form.get("file");
    if (!(value instanceof File) || !value.size) return Response.json({ error: "Elige un archivo antes de cargarlo." }, { status: 400 });
    if (value.size > MAX_FILE_SIZE) return Response.json({ error: "Cada recurso puede pesar máximo 15 MB." }, { status: 413 });
    if (!ALLOWED_TYPES.has(value.type)) return Response.json({ error: "Admite imágenes JPG, PNG o WebP, PDF, TXT y Markdown." }, { status: 415 });
    const assetId = crypto.randomUUID();
    const objectKey = `brand-assets/${ownerId}/${id}/${assetId}`;
    await env.BUCKET.put(objectKey, value.stream(), {
      httpMetadata: { contentType: value.type, cacheControl: "private, max-age=300" },
      customMetadata: { ownerId, brandId: id },
    });
    await env.DB.prepare("INSERT INTO brand_assets (id, owner_id, brand_id, name, content_type, object_key, file_size, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(assetId, ownerId, id, value.name.slice(0, 180), value.type, objectKey, value.size, Date.now()).run();
    return Response.json({ asset: { id: assetId, name: value.name, contentType: value.type, size: value.size } }, { status: 201 });
  } catch (error) {
    console.error("Unable to save brand resource", error instanceof Error ? error.message : "unknown error");
    return Response.json({ error: "No se pudo guardar el archivo." }, { status: 503 });
  }
}

