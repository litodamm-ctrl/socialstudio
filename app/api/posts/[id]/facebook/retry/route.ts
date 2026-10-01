import { env } from "@/lib/runtime";
import { ensureFacebookTables } from "@/lib/facebook";
import { ensureInstagramPublishJobs } from "@/lib/instagram-publisher";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const ownerId = request.headers.get("oai-authenticated-user-id");
  if (!ownerId) return Response.json({ error: "Inicia sesión para reintentar Facebook." }, { status: 401 });
  if (!env.DB) return Response.json({ error: "El calendario no está disponible." }, { status: 503 });
  const { id } = await context.params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return Response.json({ error: "La publicación no existe." }, { status: 404 });
  try {
    await ensureInstagramPublishJobs(env.DB);
    await ensureFacebookTables(env.DB);
    const state = await env.DB.prepare(`SELECT j.status AS instagram_status, j.facebook_status, b.auto_crosspost,
        EXISTS(SELECT 1 FROM facebook_accounts f WHERE f.owner_id = p.owner_id AND f.brand = p.brand) AS has_page
      FROM posts p JOIN instagram_publish_jobs j ON j.post_id = p.id
      LEFT JOIN brand_registry b ON b.owner_id = p.owner_id AND b.name = p.brand
      WHERE p.id = ? AND p.owner_id = ?`).bind(id, ownerId)
      .first<{ instagram_status: string; facebook_status: string; auto_crosspost: number; has_page: number }>();
    if (!state) return Response.json({ error: "No se encontró el estado de esta publicación." }, { status: 404 });
    if (state.instagram_status !== "published") return Response.json({ error: "Instagram todavía no confirmó la publicación." }, { status: 409 });
    if (!state.auto_crosspost) return Response.json({ error: "Activa la publicación cruzada en el agente de esta marca." }, { status: 409 });
    if (!state.has_page) return Response.json({ error: "Vincula la Página de Facebook de esta marca antes de reintentar." }, { status: 409 });
    if (state.facebook_status === "published") return Response.json({ error: "La publicación ya aparece como publicada en Facebook." }, { status: 409 });
    if (state.facebook_status === "publishing") return Response.json({ error: "Facebook está procesando el envío. Actualiza en un momento." }, { status: 409 });
    await env.DB.prepare("UPDATE instagram_publish_jobs SET facebook_status = 'pending', facebook_error = NULL, updated_at = ? WHERE post_id = ?")
      .bind(Date.now(), id).run();
    return Response.json({ queued: true }, { status: 202 });
  } catch (error) {
    console.error("Unable to queue Facebook retry", error instanceof Error ? error.message : "unknown error");
    return Response.json({ error: "No se pudo preparar el reintento de Facebook." }, { status: 503 });
  }
}
