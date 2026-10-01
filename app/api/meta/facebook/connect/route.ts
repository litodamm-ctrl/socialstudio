import { env } from "@/lib/runtime";
import { ensureDefaultBrands, isActiveBrand } from "@/lib/brands";
import { ensureFacebookTables } from "@/lib/facebook";
import { metaHomeUrl, randomUrlSafe } from "@/lib/meta";

export async function GET(request: Request) {
  const ownerId = request.headers.get("oai-authenticated-user-id");
  if (!ownerId) return Response.json({ error: "Inicia sesión para conectar Facebook." }, { status: 401 });
  if (!env.DB || !env.INSTAGRAM_APP_ID || !env.INSTAGRAM_APP_SECRET) return Response.redirect(metaHomeUrl("facebook_config_missing"), 303);
  const brand = new URL(request.url).searchParams.get("brand") ?? "";
  try {
    await ensureDefaultBrands(env.DB, ownerId);
    await ensureFacebookTables(env.DB);
    if (!(await isActiveBrand(env.DB, ownerId, brand))) return Response.json({ error: "Elige una marca disponible." }, { status: 400 });
    const state = randomUrlSafe();
    const now = Date.now();
    await env.DB.prepare("DELETE FROM facebook_oauth_states WHERE expires_at <= ?").bind(now).run();
    await env.DB.prepare("INSERT INTO facebook_oauth_states (state, owner_id, brand, expires_at, created_at) VALUES (?, ?, ?, ?, ?)")
      .bind(state, ownerId, brand, now + 10 * 60_000, now).run();
    const callback = new URL("/api/meta/facebook/callback", request.url).toString();
    const version = env.META_GRAPH_VERSION || "v26.0";
    const authorize = new URL(`https://www.facebook.com/${version}/dialog/oauth`);
    authorize.searchParams.set("client_id", env.INSTAGRAM_APP_ID);
    authorize.searchParams.set("redirect_uri", callback);
    authorize.searchParams.set("response_type", "code");
    authorize.searchParams.set("scope", "pages_show_list,pages_read_engagement,pages_manage_posts,instagram_basic");
    authorize.searchParams.set("state", state);
    return Response.redirect(authorize.toString(), 302);
  } catch (error) {
    console.error("Unable to start Facebook Page authorization", error instanceof Error ? error.message : "unknown error");
    return Response.redirect(metaHomeUrl("facebook_connect_failed"), 303);
  }
}
