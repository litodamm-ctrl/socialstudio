import { createR2PresignedUrl, env } from "@/lib/runtime";
import { ensureDefaultBrands } from "@/lib/brands";

const MAX_FILE_SIZE = 15 * 1024 * 1024;
const ALLOWED_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "application/pdf", "text/plain", "text/markdown"]);

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const ownerId = request.headers.get("oai-authenticated-user-id");
  if (!ownerId) return Response.json({ error: "Inicia sesión para agregar recursos de marca." }, { status: 401 });
  if (!env.DB || !env.BUCKET) return Response.json({ error: "La biblioteca de marca no está disponible." }, { status: 503 });
  const { id: brandId } = await context.params;
  try {
    await ensureDefaultBrands(env.DB, ownerId);
    const brand = await env.DB.prepare("SELECT id FROM brand_registry WHERE id = ? AND owner_id = ? AND active = 1").bind(brandId, ownerId).first<{ id: string }>();
    if (!brand) return Response.json({ error: "La marca no existe o está archivada." }, { status: 404 });
    const input = await request.json() as { contentType?: unknown; size?: unknown };
    const contentType = typeof input.contentType === "string" ? input.contentType : "";
    const size = Number(input.size);
    if (!ALLOWED_TYPES.has(contentType)) return Response.json({ error: "Admite imágenes JPG, PNG o WebP, PDF, TXT y Markdown." }, { status: 415 });
    if (!Number.isSafeInteger(size) || size < 1 || size > MAX_FILE_SIZE) return Response.json({ error: "Cada recurso puede pesar máximo 15 MB." }, { status: 413 });
    const assetId = crypto.randomUUID();
    const objectKey = `brand-assets/${ownerId}/${brandId}/${assetId}`;
    const headers = { "content-type": contentType, "x-amz-meta-ownerid": ownerId, "x-amz-meta-brandid": brandId };
    const uploadUrl = await createR2PresignedUrl("PUT", objectKey, headers, 600);
    return Response.json({ uploadUrl, headers, assetId, objectKey }, { status: 201 });
  } catch (error) {
    console.error("Unable to create a direct brand asset upload URL", error instanceof Error ? error.message : "unknown error");
    return Response.json({ error: "No se pudo preparar la carga del recurso." }, { status: 503 });
  }
}

