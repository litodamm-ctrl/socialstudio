import { env } from "@/lib/runtime";

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_VIDEO_BYTES = 50 * 1024 * 1024;
const supportedTypes = new Set(["image/jpeg", "video/mp4"]);

function currentUser(request: Request) {
  return request.headers.get("oai-authenticated-user-id");
}

export async function POST(request: Request) {
  const ownerId = currentUser(request);
  if (!ownerId) return Response.json({ error: "Inicia sesión para cargar contenido." }, { status: 401 });
  if (!env.BUCKET) return Response.json({ error: "El almacenamiento de medios todavía no está disponible." }, { status: 503 });

  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > MAX_VIDEO_BYTES + 128 * 1024) {
    return Response.json({ error: "El video supera el límite de 50 MB." }, { status: 413 });
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return Response.json({ error: "No pudimos leer el archivo. Intenta cargarlo otra vez." }, { status: 400 });
  }

  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return Response.json({ error: "Selecciona una imagen JPG o un video MP4." }, { status: 400 });
  }
  if (!supportedTypes.has(file.type)) {
    return Response.json({ error: "Por ahora se admiten imágenes JPG y videos MP4." }, { status: 415 });
  }
  const maxBytes = file.type === "image/jpeg" ? MAX_IMAGE_BYTES : MAX_VIDEO_BYTES;
  if (file.size > maxBytes) {
    return Response.json({ error: file.type === "image/jpeg" ? "La imagen debe pesar máximo 8 MB." : "El video debe pesar máximo 50 MB." }, { status: 413 });
  }

  const signature = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  const isJpeg = file.type === "image/jpeg" && signature[0] === 0xff && signature[1] === 0xd8 && signature[2] === 0xff;
  const isMp4 = file.type === "video/mp4" && String.fromCharCode(...signature.slice(4, 8)) === "ftyp";
  if (!isJpeg && !isMp4) return Response.json({ error: "El archivo no coincide con el formato JPG o MP4 seleccionado." }, { status: 415 });

  const id = crypto.randomUUID();
  try {
    await env.BUCKET.put(`media/${id}`, file.stream(), {
      httpMetadata: { contentType: file.type, cacheControl: "private, max-age=300" },
      customMetadata: { ownerId },
    });
    return Response.json({ mediaUrl: `/api/media/${id}`, mediaType: file.type, size: file.size }, { status: 201 });
  } catch (error) {
    console.error("Unable to store Instagram media", error instanceof Error ? error.message : "unknown error");
    return Response.json({ error: "No se pudo guardar el archivo. Intenta de nuevo." }, { status: 503 });
  }
}
