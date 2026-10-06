import { env } from "@/lib/runtime";
import { ensureDefaultBrands } from "@/lib/brands";
import { ensureFacebookTables } from "@/lib/facebook";
import { normalizeWebsiteUrls } from "@/lib/website-sources";

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const ownerId = request.headers.get("oai-authenticated-user-id");
  if (!ownerId) return Response.json({ error: "Inicia sesión para modificar la marca." }, { status: 401 });
  if (!env.DB) return Response.json({ error: "Las marcas no están disponibles todavía." }, { status: 503 });
  const { id } = await context.params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return Response.json({ error: "La marca no existe." }, { status: 404 });
  let input: Record<string, unknown>;
  try { input = await request.json() as Record<string, unknown>; }
  catch { return Response.json({ error: "Revisa los cambios de la marca." }, { status: 400 }); }
  try {
    await ensureDefaultBrands(env.DB, ownerId);
    const current = await env.DB.prepare("SELECT id, name, brand_essence, auto_schedule FROM brand_registry WHERE id = ? AND owner_id = ?")
      .bind(id, ownerId).first<{ id: string; name: string; brand_essence: string; auto_schedule: number }>();
    if (!current) return Response.json({ error: "La marca no existe." }, { status: 404 });
    const fields: string[] = [];
    const values: unknown[] = [];
    if (typeof input.active === "boolean") { fields.push("active = ?"); values.push(input.active ? 1 : 0); if (!input.active) fields.push("auto_schedule = 0"); }
    if (typeof input.essence === "string") {
      const value = input.essence.trim();
      if (value.length > 4000) return Response.json({ error: "La esencia de marca admite hasta 4.000 caracteres." }, { status: 400 });
      fields.push("brand_essence = ?"); values.push(value);
    }
    if ("websiteUrls" in input || "websiteUrl" in input) {
      let urls: string[];
      try {
        urls = normalizeWebsiteUrls("websiteUrls" in input ? input.websiteUrls : [input.websiteUrl]);
      } catch (error) {
        return Response.json({ error: error instanceof Error ? error.message : "Revisa las direcciones web." }, { status: 400 });
      }
      fields.push("website_urls = ?", "website_url = ?"); values.push(JSON.stringify(urls), urls[0] ?? "");
    }
    if (typeof input.driveFolderUrl === "string") {
      const value = input.driveFolderUrl.trim();
      if (value && !/^(?:https:\/\/drive\.google\.com\/(?:drive\/folders\/|file\/d\/)|https:\/\/docs\.google\.com\/document\/d\/)[\w-]+/i.test(value)) return Response.json({ error: "Pega un enlace de carpeta o archivo de Google Drive." }, { status: 400 });
      const folderId = value.match(/drive\.google\.com\/drive\/folders\/([\w-]+)/i)?.[1] ?? "";
      fields.push("drive_folder_url = ?"); values.push(value);
      fields.push("drive_folder_id = ?"); values.push(folderId);
    }
    if (typeof input.autoSchedule === "boolean") {
      if (input.autoSchedule) {
        const essence = typeof input.essence === "string" ? input.essence.trim() : current.brand_essence;
        if (essence.length < 20) return Response.json({ error: "Completa al menos 20 caracteres de esencia antes de activar el agente." }, { status: 409 });
        const account = await env.DB.prepare("SELECT brand FROM instagram_accounts WHERE owner_id = ? AND brand = ?")
          .bind(ownerId, current.name).first<{ brand: string }>();
        if (!account) return Response.json({ error: "Conecta primero la cuenta de Instagram de esta marca." }, { status: 409 });
        if (!env.OPENAI_API_KEY || !env.BUCKET || !process.env.CRON_SECRET || !env.SITE_ORIGIN || !env.INSTAGRAM_TOKEN_ENCRYPTION_KEY) return Response.json({ error: "Completa OpenAI, R2, SITE_ORIGIN, CRON_SECRET y la clave de cifrado de Instagram antes de activar el piloto." }, { status: 409 });
      }
      fields.push("auto_schedule = ?"); values.push(input.autoSchedule ? 1 : 0);
    }
    if (typeof input.autoCrosspost === "boolean") {
      if (input.autoCrosspost) {
        await ensureFacebookTables(env.DB);
        const page = await env.DB.prepare("SELECT page_id FROM facebook_accounts WHERE owner_id = ? AND brand = ?")
          .bind(ownerId, current.name).first<{ page_id: string }>();
        if (!page) return Response.json({ error: "Vincula primero la Página de Facebook de esta marca." }, { status: 409 });
      }
      fields.push("auto_crosspost = ?"); values.push(input.autoCrosspost ? 1 : 0);
    }
    if (typeof input.autoStories === "boolean") { fields.push("auto_stories = ?"); values.push(input.autoStories ? 1 : 0); }
    if (typeof input.storyTime === "string") {
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(input.storyTime)) return Response.json({ error: "Elige una hora válida para las historias." }, { status: 400 });
      fields.push("story_time = ?"); values.push(input.storyTime);
    }
    if (Array.isArray(input.postingDays)) {
      const days = [...new Set(input.postingDays.filter((day): day is number => Number.isInteger(day) && day >= 0 && day <= 6))].sort();
      if (days.length < 1 || days.length > 7) return Response.json({ error: "Elige de 1 a 7 días por semana." }, { status: 400 });
      fields.push("posting_days = ?"); values.push(JSON.stringify(days));
    }
    if (typeof input.preferredTime === "string") {
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(input.preferredTime)) return Response.json({ error: "Elige una hora válida." }, { status: 400 });
      fields.push("preferred_time = ?"); values.push(input.preferredTime);
    }
    if (!fields.length) return Response.json({ error: "No hay cambios para guardar." }, { status: 400 });
    fields.push("updated_at = ?"); values.push(Date.now()); values.push(id, ownerId);
    await env.DB.prepare(`UPDATE brand_registry SET ${fields.join(", ")} WHERE id = ? AND owner_id = ?`).bind(...values).run();
    return Response.json({ updated: true });
  } catch (error) {
    console.error("Unable to update brand", error instanceof Error ? error.message : "unknown error");
    return Response.json({ error: "No se pudo actualizar la marca." }, { status: 503 });
  }
}
