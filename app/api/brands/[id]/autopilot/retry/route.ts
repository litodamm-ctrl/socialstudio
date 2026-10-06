import { env } from "@/lib/runtime";
import { ensureDefaultBrands } from "@/lib/brands";
import { ensureAutopilotTables } from "@/lib/autopilot";
import { retryFailedSlots } from "@/lib/autopilot-recovery";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const ownerId = request.headers.get("oai-authenticated-user-id");
  if (!ownerId) return Response.json({ error: "Inicia sesión para recuperar los pendientes." }, { status: 401 });
  if (!env.DB) return Response.json({ error: "La base de datos no está disponible." }, { status: 503 });
  const { id } = await context.params;
  try {
    await ensureDefaultBrands(env.DB, ownerId);
    await ensureAutopilotTables(env.DB);
    const brand = await env.DB.prepare("SELECT auto_schedule FROM brand_registry WHERE owner_id = ? AND id = ? AND active = 1")
      .bind(ownerId, id).first<{ auto_schedule: number }>();
    if (!brand) return Response.json({ error: "No se encontró la marca activa." }, { status: 404 });
    if (!brand.auto_schedule) return Response.json({ error: "Activa y guarda el piloto antes de reintentar." }, { status: 409 });
    return Response.json({ retried: await retryFailedSlots(env.DB, ownerId, id) });
  } catch {
    return Response.json({ error: "No se pudieron recuperar los pendientes." }, { status: 503 });
  }
}
