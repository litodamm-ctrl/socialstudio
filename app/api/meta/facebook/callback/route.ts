import { env } from "@/lib/runtime";
import { encryptInstagramToken, metaHomeUrl } from "@/lib/meta";
import { ensureFacebookTables } from "@/lib/facebook";

type SavedState = { owner_id: string; brand: string };
type OAuthToken = { access_token?: string; expires_in?: number; error?: { message?: string } };
type ManagedPages = { data?: Array<{ id: string; name: string; access_token: string; instagram_business_account?: { id: string } }> };

export async function GET(request: Request) {
  if (!env.DB) return Response.redirect(metaHomeUrl("storage_unavailable"), 303);
  const callback = new URL(request.url);
  const state = callback.searchParams.get("state");
  if (!state || state.length > 160) return Response.redirect(metaHomeUrl("facebook_invalid_state"), 303);
  let saved: SavedState | null;
  try {
    await ensureFacebookTables(env.DB);
    saved = await env.DB.prepare("DELETE FROM facebook_oauth_states WHERE state = ? AND expires_at > ? RETURNING owner_id, brand")
      .bind(state, Date.now()).first<SavedState>();
  } catch {
    return Response.redirect(metaHomeUrl("storage_unavailable"), 303);
  }
  if (!saved) return Response.redirect(metaHomeUrl("facebook_invalid_state"), 303);
  if (callback.searchParams.has("error")) return Response.redirect(metaHomeUrl("facebook_cancelled"), 303);
  const code = callback.searchParams.get("code");
  if (!code || !env.INSTAGRAM_APP_ID || !env.INSTAGRAM_APP_SECRET || !env.INSTAGRAM_TOKEN_ENCRYPTION_KEY) {
    return Response.redirect(metaHomeUrl("facebook_config_missing"), 303);
  }

  try {
    const version = env.META_GRAPH_VERSION || "v26.0";
    const redirectUri = new URL("/api/meta/facebook/callback", request.url).toString();
    const tokenUrl = new URL(`https://graph.facebook.com/${version}/oauth/access_token`);
    tokenUrl.searchParams.set("client_id", env.INSTAGRAM_APP_ID);
    tokenUrl.searchParams.set("client_secret", env.INSTAGRAM_APP_SECRET);
    tokenUrl.searchParams.set("redirect_uri", redirectUri);
    tokenUrl.searchParams.set("code", code);
    const shortToken = await fetch(tokenUrl);
    const shortValue = await shortToken.json() as OAuthToken;
    if (!shortToken.ok || !shortValue.access_token) throw new Error(shortValue.error?.message ?? "Facebook no devolvió acceso.");

    const longUrl = new URL(`https://graph.facebook.com/${version}/oauth/access_token`);
    longUrl.searchParams.set("grant_type", "fb_exchange_token");
    longUrl.searchParams.set("client_id", env.INSTAGRAM_APP_ID);
    longUrl.searchParams.set("client_secret", env.INSTAGRAM_APP_SECRET);
    longUrl.searchParams.set("fb_exchange_token", shortValue.access_token);
    const longResponse = await fetch(longUrl);
    const longToken = await longResponse.json() as OAuthToken;
    if (!longResponse.ok || !longToken.access_token) throw new Error(longToken.error?.message ?? "Facebook no pudo prolongar el acceso.");

    const accounts = await env.DB.prepare("SELECT instagram_user_id FROM instagram_accounts WHERE owner_id = ? AND brand = ?")
      .bind(saved.owner_id, saved.brand).first<{ instagram_user_id: string }>();
    if (!accounts) return Response.redirect(metaHomeUrl("facebook_instagram_missing"), 303);
    const pagesUrl = new URL(`https://graph.facebook.com/${version}/me/accounts`);
    pagesUrl.searchParams.set("fields", "id,name,access_token,instagram_business_account{id}");
    pagesUrl.searchParams.set("access_token", longToken.access_token);
    const pagesResponse = await fetch(pagesUrl);
    const pages = await pagesResponse.json() as ManagedPages & { error?: { message?: string } };
    if (!pagesResponse.ok) throw new Error(pages.error?.message ?? "No se pudieron consultar las Páginas.");
    const match = pages.data?.find((page) => page.instagram_business_account?.id === accounts.instagram_user_id && page.access_token);
    if (!match) return Response.redirect(metaHomeUrl("facebook_page_not_linked"), 303);

    const encrypted = await encryptInstagramToken(match.access_token);
    const expiresAt = Date.now() + Math.max(0, Number(longToken.expires_in ?? 60 * 24 * 60 * 60)) * 1000;
    const now = Date.now();
    await env.DB.prepare("INSERT INTO facebook_accounts (id, owner_id, brand, page_id, page_name, instagram_user_id, encrypted_page_token, token_expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(owner_id, brand) DO UPDATE SET page_id = excluded.page_id, page_name = excluded.page_name, instagram_user_id = excluded.instagram_user_id, encrypted_page_token = excluded.encrypted_page_token, token_expires_at = excluded.token_expires_at, updated_at = excluded.updated_at")
      .bind(crypto.randomUUID(), saved.owner_id, saved.brand, match.id, match.name, accounts.instagram_user_id, encrypted, expiresAt, now, now).run();
    await env.DB.prepare("UPDATE brand_registry SET auto_crosspost = 1, updated_at = ? WHERE owner_id = ? AND name = ? AND active = 1")
      .bind(now, saved.owner_id, saved.brand).run();
    return Response.redirect(metaHomeUrl("facebook_connected"), 303);
  } catch (error) {
    console.error("Facebook Page connection failed", error instanceof Error ? error.message.slice(0, 240) : "unknown error");
    return Response.redirect(metaHomeUrl("facebook_connect_failed"), 303);
  }
}
