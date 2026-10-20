import { env } from "@/lib/runtime";
import { ensureSeo } from "@/lib/seo";
import { googleCapabilities, googleConfigured, googleResources, seoGoogleCallback, storeGoogleToken } from "@/lib/seo-google";

// Only exact, locally authored helper messages may cross this boundary.
const publicErrors = new Set([
  "Configura SITE_ORIGIN con HTTPS.",
  "Conecta Google para consultar datos reales.",
  "Reconecta Google; no se pudo renovar el acceso.",
  "Google no entregó acceso.",
  "La autorización de Google caducó. Pulsa Reconectar Google.",
  "No se pudieron comprobar los permisos de Google. Vuelve a cargar la conexión.",
]);

export async function GET(request: Request) {
  const owner = request.headers.get("oai-authenticated-user-id");
  if (!owner) return Response.json({ error: "Inicia sesión." }, { status: 401 });
  if (!env.DB) return Response.json({ error: "Configura la base de datos." }, { status: 503 });
  const url = new URL(request.url);
  try {
    await ensureSeo(env.DB);
    if (url.searchParams.has("code") || url.searchParams.has("error")) {
      const state = url.searchParams.get("state") ?? "";
      const valid = await env.DB.prepare("DELETE FROM seo_google_states WHERE state = ? AND owner_id = ? AND expires_at > ? RETURNING state").bind(state, owner, Date.now()).first();
      if (!valid || url.searchParams.has("error") || !url.searchParams.get("code")) return Response.json({ error: "Autorización cancelada o caducada." }, { status: 400 });
      const callback = seoGoogleCallback();
      const response = await fetch("https://oauth2.googleapis.com/token", { method: "POST", signal: AbortSignal.timeout(20_000), redirect: "error", cache: "no-store", body: new URLSearchParams({
        code: url.searchParams.get("code")!, client_id: process.env.GOOGLE_CLIENT_ID!, client_secret: process.env.GOOGLE_CLIENT_SECRET!, redirect_uri: callback, grant_type: "authorization_code",
      }) });
      const data = await response.json().catch(() => null) as { refresh_token?: unknown; scope?: unknown; refresh_token_expires_in?: unknown } | null;
      if (!response.ok || typeof data?.refresh_token !== "string" || !data.refresh_token.trim()) return Response.json({ error: "Google no entregó autorización persistente. Vuelve a conectar." }, { status: 400 });
      await storeGoogleToken(env.DB, owner, data.refresh_token, typeof data.scope === "string" ? data.scope : undefined, typeof data.refresh_token_expires_in === "number" ? data.refresh_token_expires_in : undefined);
      const capabilities = await googleCapabilities(env.DB, owner);
      const status = capabilities.search === false || capabilities.business === false ? "partial" : "connected";
      return Response.redirect(new URL(`/?section=seo&google=${status}`, callback).href, 303);
    }
    if (url.searchParams.get("action") === "resources") return Response.json(await googleResources(env.DB, owner), { headers: { "Cache-Control": "no-store" } });
    if (!googleConfigured()) return Response.json({ error: "Configura GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, SITE_ORIGIN y la clave de cifrado. Registra /api/seo/google como callback HTTPS en Google Cloud." }, { status: 409 });
    const state = crypto.randomUUID();
    await env.DB.prepare("DELETE FROM seo_google_states WHERE expires_at < ?").bind(Date.now()).run();
    await env.DB.prepare("INSERT INTO seo_google_states (state, owner_id, expires_at) VALUES (?, ?, ?)").bind(state, owner, Date.now() + 10 * 60_000).run();
    const target = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    target.search = new URLSearchParams({ client_id: process.env.GOOGLE_CLIENT_ID!, redirect_uri: seoGoogleCallback(), response_type: "code", access_type: "offline", prompt: "consent", state,
      scope: "https://www.googleapis.com/auth/webmasters.readonly https://www.googleapis.com/auth/business.manage" }).toString();
    return Response.json({ url: target.href });
  } catch (e) {
    return Response.json({ error: e instanceof Error && publicErrors.has(e.message) ? e.message : "No se pudo conectar Google. Vuelve a intentarlo." }, { status: 400 });
  }
}
export async function DELETE(request: Request) {
  const owner = request.headers.get("oai-authenticated-user-id");
  if (!owner) return Response.json({ error: "Inicia sesión." }, { status: 401 });
  if (!env.DB) return Response.json({ error: "Base de datos no disponible." }, { status: 503 });
  try {
    await ensureSeo(env.DB);
    await googleCapabilities(env.DB, owner); // Ensure the supplemental table for legacy connections.
    await env.DB.batch([
      env.DB.prepare("DELETE FROM seo_google WHERE owner_id = ?").bind(owner),
      env.DB.prepare("DELETE FROM seo_google_capabilities WHERE owner_id = ?").bind(owner),
      env.DB.prepare("UPDATE seo_settings SET search_property = '', google_location = '' WHERE owner_id = ?").bind(owner),
    ]);
    return Response.json({ disconnected: true });
  } catch { return Response.json({ error: "No se pudo desconectar Google. Vuelve a intentarlo." }, { status: 400 }); }
}
