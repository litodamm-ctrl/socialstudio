import { env } from "@/lib/runtime";
import { ensureInstagramPublishJobs } from "@/lib/instagram-publisher";

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
