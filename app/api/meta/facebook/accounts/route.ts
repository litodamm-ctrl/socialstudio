import { env } from "@/lib/runtime";
import { ensureFacebookTables } from "@/lib/facebook";

export async function GET(request: Request) {
  const ownerId = request.headers.get("oai-authenticated-user-id");
  if (!ownerId) return Response.json({ error: "Inicia sesión para ver las Páginas conectadas." }, { status: 401 });
  if (!env.DB) return Response.json({ error: "Las Páginas no están disponibles todavía." }, { status: 503 });
  try {
    await ensureFacebookTables(env.DB);
    const result = await env.DB.prepare("SELECT brand, page_name AS pageName, page_id AS pageId, token_expires_at AS tokenExpiresAt FROM facebook_accounts WHERE owner_id = ? ORDER BY brand")
      .bind(ownerId).all<{ brand: string; pageName: string; pageId: string; tokenExpiresAt: number }>();
    return Response.json({ accounts: result.results ?? [] });
  } catch (error) {
    console.error("Unable to list Facebook Pages", error instanceof Error ? error.message : "unknown error");
    return Response.json({ error: "No se pudieron consultar las Páginas." }, { status: 503 });
  }
}
