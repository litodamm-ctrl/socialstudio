import { env } from "@/lib/runtime";
import { ensureInstagramPublishJobs } from "@/lib/instagram-publisher";

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const ownerId = request.headers.get("oai-authenticated-user-id");
  if (!ownerId) return Response.json({ error: "Inicia sesión para editar." }, { status: 401 });
  if (!env.DB) return Response.json({ error: "El calendario no está disponible." }, { status: 503 });
  const { id } = await context.params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return Response.json({ error: "Publicación no encontrada." }, { status: 404 });
  let input: Record<string, unknown>;
  try { input = await request.json(); } catch { return Response.json({ error: "Revisa los datos." }, { status: 400 }); }
  try {
    await ensureInstagramPublishJobs(env.DB);
    const current = await env.DB.prepare("SELECT * FROM posts WHERE id = ? AND owner_id = ?").bind(id, ownerId)
      .first<{brand:string; caption:string; media_type:string; media_url:string; scheduled_at:string|null; status:string; created_at:number}>();
    if (!current) return Response.json({ error: "Publicación no encontrada." }, { status: 404 });
    const job = await env.DB.prepare("SELECT status FROM instagram_publish_jobs WHERE post_id = ? AND owner_id = ?").bind(id, ownerId).first<{status:string}>();
    if (current.status === "published" || ["processing","publishing","published"].includes(job?.status ?? "")) return Response.json({ error: "La publicación ya se envió o está procesándose." }, { status: 409 });
    const caption = typeof input.caption === "string" ? input.caption.trim() : current.caption;
    const mediaType = typeof input.mediaType === "string" ? input.mediaType : current.media_type;
    const mediaUrl = typeof input.mediaUrl === "string" ? input.mediaUrl : current.media_url;
    const status = input.status === "draft" ? "draft" : input.status === "scheduled" ? "scheduled" : current.status;
    const date = typeof input.scheduledAt === "string" ? input.scheduledAt : current.scheduled_at;
    if (status === "scheduled" && !mediaUrl) return Response.json({ error: "Adjunta el archivo antes de programar." }, { status: 400 });
    if (!caption || caption.length > 2200 || !["Imagen","Historia","Reel"].includes(mediaType)) return Response.json({ error: "Revisa el texto y el formato." }, { status: 400 });
    if (status === "scheduled" && (!date || !Number.isFinite(Date.parse(date)) || Date.parse(date) <= Date.now())) return Response.json({ error: "Elige una fecha futura." }, { status: 400 });
    if (mediaUrl) {
      const mediaId = mediaUrl.match(/^\/api\/media\/([0-9a-f-]{36})$/i)?.[1];
      if (!mediaId || !env.BUCKET) return Response.json({ error: "Archivo inválido." }, { status: 400 });
      const object = await env.BUCKET.head(`media/${mediaId}`);
      if (!object || object.customMetadata?.ownerId !== ownerId || object.httpMetadata?.contentType !== (mediaType === "Reel" ? "video/mp4" : "image/jpeg")) return Response.json({ error: "Adjunta un JPG para feed/historia o un MP4 para Reel." }, { status: 400 });
    }
    const scheduledAt = status === "scheduled" ? new Date(date!).toISOString() : null;
    const result = await env.DB.batch([
      env.DB.prepare("DELETE FROM instagram_publish_jobs WHERE post_id = ? AND owner_id = ? AND status IN ('pending','failed')").bind(id, ownerId),
      env.DB.prepare(`UPDATE posts SET caption = ?, media_type = ?, media_url = ?, scheduled_at = ?, status = ?
        WHERE id = ? AND owner_id = ? AND status IN ('draft','scheduled')
        AND NOT EXISTS (SELECT 1 FROM instagram_publish_jobs WHERE post_id = ? AND status IN ('processing','publishing','published'))`)
        .bind(caption, mediaType, mediaUrl, scheduledAt, status, id, ownerId, id),
    ]);
    if (result[1]?.meta.changes !== 1) return Response.json({ error: "La publicación ya se envió o está procesándose. Actualiza el calendario." }, { status: 409 });
    return Response.json({post:{id,brand:current.brand,caption,mediaType,mediaUrl,scheduledAt,status,publicationError:null,facebookStatus:null,facebookError:null,createdAt:new Date(current.created_at).toISOString()}});
  } catch (error) {
    console.error("Unable to edit scheduled post", error instanceof Error ? error.message : "Unknown error");
    return Response.json({error:"No se pudo guardar la edición."},{status:503});
  }
}

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  const ownerId = request.headers.get("oai-authenticated-user-id");
  if (!ownerId) return Response.json({ error: "Inicia sesión para cancelar la publicación." }, { status: 401 });
  if (!env.DB) return Response.json({ error: "El calendario todavía no está disponible." }, { status: 503 });
  const { id } = await context.params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return Response.json({ error: "La publicación no existe." }, { status: 404 });

  try {
    await ensureInstagramPublishJobs(env.DB);
    const post = await env.DB.prepare(
      "SELECT p.status, j.status AS publication_status FROM posts p LEFT JOIN instagram_publish_jobs j ON j.post_id = p.id WHERE p.id = ? AND p.owner_id = ?",
    ).bind(id, ownerId).first<{ status: string; publication_status: string | null }>();
    if (!post) return Response.json({ error: "La publicación ya no está en el calendario." }, { status: 404 });
    if (["processing", "publishing"].includes(post.publication_status ?? "")) {
      return Response.json({ error: "Instagram ya está procesando esta publicación y no se puede cancelar en este momento." }, { status: 409 });
    }
    if (post.publication_status === "published") {
      return Response.json({ error: "Esta publicación ya fue enviada a Instagram." }, { status: 409 });
    }

    const results = await env.DB.batch([
      env.DB.prepare("DELETE FROM instagram_publish_jobs WHERE post_id = ? AND status IN ('pending', 'failed')").bind(id),
      env.DB.prepare(
        "DELETE FROM posts WHERE id = ? AND owner_id = ? AND NOT EXISTS (SELECT 1 FROM instagram_publish_jobs WHERE post_id = ? AND status IN ('processing', 'publishing', 'published'))",
      ).bind(id, ownerId, id),
    ]);
    if ((results[1]?.meta.changes ?? 0) !== 1) {
      return Response.json({ error: "La publicación empezó a procesarse antes de cancelarla. Actualiza el calendario." }, { status: 409 });
    }
    return Response.json({ deleted: true });
  } catch (error) {
    console.error("Unable to cancel Instagram planner post", error instanceof Error ? error.message : "unknown error");
    return Response.json({ error: "No se pudo cancelar la publicación. Intenta de nuevo." }, { status: 503 });
  }
}
