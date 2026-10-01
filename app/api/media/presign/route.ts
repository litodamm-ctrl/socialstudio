import { createR2PresignedUrl, env } from "@/lib/runtime";

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_VIDEO_BYTES = 50 * 1024 * 1024;

export async function POST(request: Request) {
  const ownerId = request.headers.get("oai-authenticated-user-id");
  if (!ownerId) return Response.json({ error: "Inicia sesión para cargar contenido." }, { status: 401 });
  if (!env.BUCKET) return Response.json({ error: "El almacenamiento multimedia no está disponible." }, { status: 503 });
  let input: { contentType?: unknown; size?: unknown };
  try { input = await request.json() as typeof input; }
  catch { return Response.json({ error: "No se pudieron leer los datos del archivo." }, { status: 400 }); }
  const contentType = typeof input.contentType === "string" ? input.contentType : "";
  const size = Number(input.size);
  if (!Number.isSafeInteger(size) || size < 1) return Response.json({ error: "El archivo no es válido." }, { status: 400 });
  if (contentType !== "image/jpeg" && contentType !== "video/mp4") return Response.json({ error: "Por ahora se admiten imágenes JPG y videos MP4." }, { status: 415 });
  if (size > (contentType === "image/jpeg" ? MAX_IMAGE_BYTES : MAX_VIDEO_BYTES)) return Response.json({ error: "La imagen debe pesar máximo 8 MB y el video máximo 50 MB." }, { status: 413 });
  const id = crypto.randomUUID();
  const headers = { "content-type": contentType, "x-amz-meta-ownerid": ownerId };
  try {
    const uploadUrl = await createR2PresignedUrl("PUT", `media/${id}`, headers, 600);
    return Response.json({ uploadUrl, headers, mediaUrl: `/api/media/${id}` }, { status: 201 });
  } catch (error) {
    console.error("Unable to create a direct media upload URL", error instanceof Error ? error.message : "unknown error");
    return Response.json({ error: "No se pudo preparar la carga del archivo." }, { status: 503 });
  }
}

