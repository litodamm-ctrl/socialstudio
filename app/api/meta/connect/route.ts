import { env } from "@/lib/runtime";
import { instagramRedirectUri, metaHomeUrl, randomUrlSafe } from "@/lib/meta";
import { ensureDefaultBrands, isActiveBrand } from "@/lib/brands";

export async function GET(request: Request) {
  const ownerId = request.headers.get("oai-authenticated-user-id");
  if (!ownerId) return Response.json({ error: "Inicia sesión para conectar una cuenta." }, { status: 401 });
  if (!env.DB || !env.INSTAGRAM_APP_ID || !env.INSTAGRAM_APP_SECRET) {
    return Response.redirect(metaHomeUrl("missing_app_config"), 303);
  }

  const brand = new URL(request.url).searchParams.get("brand") ?? "";
  try {
    await ensureDefaultBrands(env.DB, ownerId);
    if (!(await isActiveBrand(env.DB, ownerId, brand))) return Response.json({ error: "Elige una marca disponible." }, { status: 400 });
  } catch {
    return Response.redirect(metaHomeUrl("setup_error"), 303);
  }

  try {
    const redirectUri = instagramRedirectUri();
    const state = randomUrlSafe();
    const now = Date.now();
    await env.DB.prepare(
      "DELETE FROM instagram_oauth_states WHERE expires_at <= ?",
    ).bind(now).run();
    await env.DB.prepare(
      "INSERT INTO instagram_oauth_states (state, owner_id, brand, expires_at, created_at) VALUES (?, ?, ?, ?, ?)",
    ).bind(state, ownerId, brand, now + 10 * 60 * 1000, now).run();

    const authorize = new URL("https://www.instagram.com/oauth/authorize");
    authorize.searchParams.set("client_id", env.INSTAGRAM_APP_ID);
    authorize.searchParams.set("redirect_uri", redirectUri);
    authorize.searchParams.set("response_type", "code");
    authorize.searchParams.set("scope", "instagram_business_basic,instagram_business_content_publish");
    authorize.searchParams.set("state", state);
    authorize.searchParams.set("enable_fb_login", "0");
    authorize.searchParams.set("force_authentication", "1");
    return Response.redirect(authorize.toString(), 302);
  } catch (error) {
    console.error("Unable to start Instagram OAuth", error instanceof Error ? error.message : "unknown error");
    return Response.redirect(metaHomeUrl("setup_error"), 303);
  }
}
