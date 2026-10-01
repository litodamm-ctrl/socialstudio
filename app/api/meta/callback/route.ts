import { env } from "@/lib/runtime";
import { encryptInstagramToken, graphUrl, instagramApiError, instagramRedirectUri, metaHomeUrl } from "@/lib/meta";

type OAuthState = { owner_id: string; brand: string };
type TokenResponse = { access_token?: string; user_id?: string | number; expires_in?: number };
type InstagramProfile = { id?: string | number; username?: string };

async function readJson<T>(response: Response): Promise<T> {
  const data = await response.json() as T | { error?: { message?: string } };
  if (!response.ok) throw await instagramApiError(new Response(JSON.stringify(data), { status: response.status }));
  return data as T;
}

export async function GET(request: Request) {
  if (!env.DB) return Response.redirect(metaHomeUrl("storage_unavailable"), 303);
  const callback = new URL(request.url);
  const state = callback.searchParams.get("state");
  if (!state || state.length > 160) return Response.redirect(metaHomeUrl("invalid_state"), 303);

  let savedState: OAuthState | null;
  try {
    savedState = await env.DB.prepare(
      "DELETE FROM instagram_oauth_states WHERE state = ? AND expires_at > ? RETURNING owner_id, brand",
    ).bind(state, Date.now()).first<OAuthState>();
  } catch (error) {
    console.error("Unable to validate Instagram OAuth state", error instanceof Error ? error.message : "unknown error");
    return Response.redirect(metaHomeUrl("storage_unavailable"), 303);
  }
  if (!savedState) return Response.redirect(metaHomeUrl("invalid_state"), 303);

  if (callback.searchParams.has("error")) return Response.redirect(metaHomeUrl("cancelled"), 303);
  const code = callback.searchParams.get("code");
  if (!code || code.length > 4096) return Response.redirect(metaHomeUrl("missing_code"), 303);
  if (!env.INSTAGRAM_APP_ID || !env.INSTAGRAM_APP_SECRET || !env.INSTAGRAM_TOKEN_ENCRYPTION_KEY) {
    return Response.redirect(metaHomeUrl("missing_app_config"), 303);
  }

  try {
    const redirectUri = instagramRedirectUri();
    const form = new FormData();
    form.set("client_id", env.INSTAGRAM_APP_ID);
    form.set("client_secret", env.INSTAGRAM_APP_SECRET);
    form.set("grant_type", "authorization_code");
    form.set("redirect_uri", redirectUri);
    form.set("code", code);

    const shortToken = await readJson<TokenResponse>(await fetch("https://api.instagram.com/oauth/access_token", {
      method: "POST",
      body: form,
    }));
    if (!shortToken.access_token) throw new Error("Instagram did not return an access token.");

    const longUrl = new URL("https://graph.instagram.com/access_token");
    longUrl.searchParams.set("grant_type", "ig_exchange_token");
    longUrl.searchParams.set("client_secret", env.INSTAGRAM_APP_SECRET);
    longUrl.searchParams.set("access_token", shortToken.access_token);
    const longToken = await readJson<TokenResponse>(await fetch(longUrl));
    if (!longToken.access_token || !Number.isFinite(longToken.expires_in) || !longToken.expires_in) {
      throw new Error("Instagram did not return a long-lived access token.");
    }

    const profileUrl = new URL(graphUrl("me"));
    profileUrl.searchParams.set("fields", "id,username");
    const profileResponse = await fetch(profileUrl, {
      headers: { Authorization: `Bearer ${longToken.access_token}` },
    });
    const profile = await readJson<InstagramProfile>(profileResponse);
    const instagramUserId = String(profile.id ?? longToken.user_id ?? "");
    if (!instagramUserId || !profile.username) throw new Error("Instagram did not return a professional profile.");

    const encryptedToken = await encryptInstagramToken(longToken.access_token);
    const now = Date.now();
    const expiresAt = now + Number(longToken.expires_in) * 1000;
    await env.DB.prepare(
      "INSERT INTO instagram_accounts (id, owner_id, brand, instagram_user_id, username, encrypted_token, token_expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(owner_id, brand) DO UPDATE SET instagram_user_id = excluded.instagram_user_id, username = excluded.username, encrypted_token = excluded.encrypted_token, token_expires_at = excluded.token_expires_at, updated_at = excluded.updated_at",
    ).bind(crypto.randomUUID(), savedState.owner_id, savedState.brand, instagramUserId, profile.username, encryptedToken, expiresAt, now, now).run();

    return Response.redirect(metaHomeUrl("connected"), 303);
  } catch (error) {
    console.error("Instagram account connection failed", error instanceof Error ? error.message.slice(0, 240) : "unknown error");
    return Response.redirect(metaHomeUrl("connection_failed"), 303);
  }
}
