import { env } from "@/lib/runtime";
import { ensureInstagramPublishJobs } from "@/lib/instagram-publisher";
import { ensureDefaultBrands, isActiveBrand } from "@/lib/brands";

type PostRow = {
  id: string;
  brand: string;
  caption: string;
  media_type: string;
  media_url: string;
  scheduled_at: string | null;
  status: "draft" | "scheduled";
  publication_status: "pending" | "processing" | "publishing" | "published" | "failed" | null;
  publication_error: string | null;
  facebook_status: string | null;
  facebook_error: string | null;
  created_at: number;
};

function currentUser(request: Request) {
  return request.headers.get("oai-authenticated-user-id");
}

function toPost(row: PostRow) {
  return {
    id: row.id,
    brand: row.brand,
    caption: row.caption,
    mediaType: row.media_type,
    mediaUrl: row.media_url,
    scheduledAt: row.scheduled_at,
    status: row.publication_status === "processing" || row.publication_status === "publishing"
      ? "publishing"
      : row.publication_status === "published" || row.publication_status === "failed"
        ? row.publication_status
        : row.status,
    publicationError: row.publication_error,
    facebookStatus: row.facebook_status,
    facebookError: row.facebook_error,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

export async function GET(request: Request) {
  const ownerId = currentUser(request);
  if (!ownerId) return Response.json({ error: "Inicia sesión para ver tus publicaciones." }, { status: 401 });
  if (!env.DB) return Response.json({ error: "El calendario todavía no está disponible." }, { status: 503 });

  try {
    await ensureInstagramPublishJobs(env.DB);
    const result = await env.DB.prepare(
      "SELECT p.id, p.brand, p.caption, p.media_type, p.media_url, p.scheduled_at, p.status, p.created_at, j.status AS publication_status, j.last_error AS publication_error, j.facebook_status, j.facebook_error FROM posts p LEFT JOIN instagram_publish_jobs j ON j.post_id = p.id WHERE p.owner_id = ? ORDER BY CASE WHEN p.scheduled_at IS NULL THEN 1 ELSE 0 END, p.scheduled_at ASC, p.created_at DESC LIMIT 100",
    ).bind(ownerId).all<PostRow>();
    return Response.json({ posts: (result.results ?? []).map(toPost) });
  } catch (error) {
    console.error("Unable to load Instagram planner posts", error);
    return Response.json({ error: "No se pudo cargar el calendario. Intenta de nuevo." }, { status: 503 });
  }
}

export async function POST(request: Request) {
  const ownerId = currentUser(request);
  if (!ownerId) return Response.json({ error: "Inicia sesión para guardar una publicación." }, { status: 401 });
  if (!env.DB) return Response.json({ error: "El calendario todavía no está disponible." }, { status: 503 });

  let input: { brand?: unknown; caption?: unknown; mediaType?: unknown; mediaUrl?: unknown; scheduledAt?: unknown; status?: unknown };
  try {
    input = await request.json();
  } catch {
    return Response.json({ error: "Revisa los datos e inténtalo de nuevo." }, { status: 400 });
  }

  const brand = typeof input.brand === "string" ? input.brand : "";
  const caption = typeof input.caption === "string" ? input.caption.trim() : "";
  const mediaType = typeof input.mediaType === "string" ? input.mediaType : "Imagen";
  const mediaUrl = typeof input.mediaUrl === "string" ? input.mediaUrl : "";
  const requestedStatus = input.status === "scheduled" ? "scheduled" : "draft";
  const scheduledAt = typeof input.scheduledAt === "string" ? input.scheduledAt : null;

  try {
    await ensureDefaultBrands(env.DB, ownerId);
    if (!(await isActiveBrand(env.DB, ownerId, brand))) return Response.json({ error: "Elige una marca disponible." }, { status: 400 });
  } catch {
    return Response.json({ error: "No se pudo validar la marca." }, { status: 503 });
  }
  if (!caption || caption.length > 2200) return Response.json({ error: "El texto debe tener entre 1 y 2.200 caracteres." }, { status: 400 });
  if (!["Imagen", "Reel", "Historia"].includes(mediaType)) return Response.json({ error: "Los carruseles estarán disponibles cuando se habilite la carga de varias imágenes." }, { status: 400 });
  if (requestedStatus === "scheduled" && (!scheduledAt || !Number.isFinite(Date.parse(scheduledAt)) || Date.parse(scheduledAt) <= Date.now())) {
    return Response.json({ error: "Elige una fecha futura para agregarla al calendario." }, { status: 400 });
  }

  if (mediaUrl) {
    const mediaMatch = mediaUrl.match(/^\/api\/media\/([0-9a-f-]{36})$/i);
    if (!mediaMatch || !env.BUCKET) return Response.json({ error: "El archivo adjunto no es válido." }, { status: 400 });
    try {
      const object = await env.BUCKET.head(`media/${mediaMatch[1]}`);
      if (!object || object.customMetadata?.ownerId !== ownerId) return Response.json({ error: "El archivo adjunto no está disponible." }, { status: 400 });
      const contentType = object.httpMetadata?.contentType ?? "";
      const formatMatches = mediaType === "Imagen" ? contentType === "image/jpeg" : mediaType === "Reel" ? contentType === "video/mp4" : ["image/jpeg", "video/mp4"].includes(contentType);
      if (!formatMatches) return Response.json({ error: mediaType === "Reel" ? "Para un Reel, adjunta un video MP4." : "El archivo no coincide con el formato elegido." }, { status: 400 });
    } catch (error) {
      console.error("Unable to validate Instagram media", error instanceof Error ? error.message : "unknown error");
      return Response.json({ error: "No se pudo validar el archivo adjunto." }, { status: 503 });
    }
  }

  const post = {
    id: crypto.randomUUID(),
    brand,
    caption,
    mediaType,
    mediaUrl,
    scheduledAt: requestedStatus === "scheduled" ? new Date(scheduledAt!).toISOString() : null,
    status: requestedStatus,
    createdAt: new Date().toISOString(),
  };

  try {
    await env.DB.prepare(
      "INSERT INTO posts (id, owner_id, brand, caption, media_type, media_url, scheduled_at, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).bind(post.id, ownerId, post.brand, post.caption, post.mediaType, post.mediaUrl, post.scheduledAt, post.status, Date.now()).run();
    return Response.json({ post }, { status: 201 });
  } catch (error) {
    console.error("Unable to save Instagram planner post", error);
    return Response.json({ error: "No se pudo guardar. Intenta de nuevo." }, { status: 503 });
  }
}
