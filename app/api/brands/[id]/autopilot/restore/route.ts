import { env } from "@/lib/runtime";
import { ensureDefaultBrands } from "@/lib/brands";
import { ensureAutopilotTables } from "@/lib/autopilot";
import { ensureInstagramPublishJobs } from "@/lib/instagram-publisher";
import { restoreAgentCalendar } from "@/lib/restore-agent-calendar";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const owner = request.headers.get("oai-authenticated-user-id");
  if (!owner) return Response.json({ error: "Inicia sesión para recuperar el calendario." }, { status: 401 });
  if (!env.DB) return Response.json({ error: "La base de datos no está disponible." }, { status: 503 });
  const { id } = await context.params;
  try {
    const input = await request.json() as { username?: unknown };
    if (typeof input.username !== "string" || !input.username) return Response.json({ error: "Confirma la cuenta de destino." }, { status: 400 });
    await ensureDefaultBrands(env.DB, owner);
    await ensureAutopilotTables(env.DB);
    await ensureInstagramPublishJobs(env.DB);
    const brand = await env.DB.prepare(`SELECT b.auto_schedule, a.username FROM brand_registry b LEFT JOIN instagram_accounts a ON a.owner_id = b.owner_id AND a.brand = b.name WHERE b.owner_id = ? AND b.id = ? AND b.active = 1`).bind(owner, id).first<{auto_schedule:number; username:string|null}>();
    if (!brand?.auto_schedule || brand.username !== input.username) return Response.json({ error: "Activa y guarda el piloto y verifica la cuenta conectada antes de recuperar." }, { status: 409 });
    return Response.json(await restoreAgentCalendar(env.DB, owner, id, input.username));
  } catch (error) {
    console.error("Unable to restore agent calendar", error instanceof Error ? error.message : "unknown");
    return Response.json({ error: "No se pudo completar la recuperación. Actualiza el estado antes de reintentar." }, { status: 503 });
  }
}
