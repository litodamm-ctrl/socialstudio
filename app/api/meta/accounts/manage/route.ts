import { env } from "@/lib/runtime";
import { ensureDefaultBrands } from "@/lib/brands";
import { ensureAutopilotTables } from "@/lib/autopilot";
import { ensureFacebookTables } from "@/lib/facebook";
import { ensureInstagramPublishJobs } from "@/lib/instagram-publisher";
import { changeInstagramConnection } from "@/lib/account-connections";

export async function POST(request: Request) {
  const owner = request.headers.get("oai-authenticated-user-id");
  if (!owner) return Response.json({ error: "Inicia sesión para administrar las conexiones." }, { status: 401 });
  if (!env.DB) return Response.json({ error: "Base de datos no disponible." }, { status: 503 });
  let input: { action?: string; brand?: string; username?: string; target?: string };
  try { input = await request.json() as typeof input; } catch { return Response.json({ error: "Solicitud inválida." }, { status: 400 }); }
  if (!input || !["disconnect", "move"].includes(input.action || "") || typeof input.brand !== "string" || typeof input.username !== "string" || !input.brand || !input.username || (input.action === "move" && (typeof input.target !== "string" || !input.target || input.target === input.brand))) return Response.json({ error: "Selecciona la cuenta y una marca de destino diferente." }, { status: 400 });
  try {
    await ensureDefaultBrands(env.DB, owner);
    await ensureAutopilotTables(env.DB);
    await ensureFacebookTables(env.DB);
    await ensureInstagramPublishJobs(env.DB);
    const changed = await changeInstagramConnection(env.DB, owner, input.brand, input.username, input.action === "move" ? input.target : undefined);
    if (!changed) return Response.json({ error: "No se cambió la conexión: la cuenta cambió, la marca destino ya está conectada o hay un envío en curso. Actualiza el estado e intenta de nuevo cuando termine." }, { status: 409 });
    return Response.json({ updated: true });
  } catch { return Response.json({ error: "No se pudo cambiar la conexión. Intenta nuevamente." }, { status: 503 }); }
}
