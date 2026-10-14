import { env } from "@/lib/runtime";
import { ensureSeo } from "@/lib/seo";
import { googleConfigured, googleResources, seoGoogleCallback, storeGoogleToken } from "@/lib/seo-google";

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
      if (!valid || url.searchParams.has("error")) throw new Error("Autorización cancelada o caducada.");
      const response = await fetch("https://oauth2.googleapis.com/token", { method: "POST", signal: AbortSignal.timeout(20_000), body: new URLSearchParams({
        code: url.searchParams.get("code")!, client_id: process.env.GOOGLE_CLIENT_ID!, client_secret: process.env.GOOGLE_CLIENT_SECRET!, redirect_uri: seoGoogleCallback(), grant_type: "authorization_code",
      }) });
      const data = await response.json() as { refresh_token?: string };
      if (!response.ok || !data.refresh_token) throw new Error("Google no entregó autorización persistente. Vuelve a conectar.");
      await storeGoogleToken(env.DB, owner, data.refresh_token);
      return Response.redirect(new URL("/?section=seo&google=connected", process.env.SITE_ORIGIN!).href, 303);
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
    return Response.json({ error: e instanceof Error ? e.message : "No se pudo conectar Google." }, { status: 400 });
  }
}
export async function DELETE(request: Request) {
  const owner = request.headers.get("oai-authenticated-user-id");
  if (!owner) return Response.json({ error: "Inicia sesión." }, { status: 401 });
  if (!env.DB) return Response.json({ error: "Base de datos no disponible." }, { status: 503 });
  await ensureSeo(env.DB);
  await env.DB.prepare("DELETE FROM seo_google WHERE owner_id = ?").bind(owner).run();
  await env.DB.prepare("UPDATE seo_settings SET search_property = '', google_location = '' WHERE owner_id = ?").bind(owner).run();
  return Response.json({ disconnected: true });
}
