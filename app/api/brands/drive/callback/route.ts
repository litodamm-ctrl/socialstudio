import { env } from "@/lib/runtime";
import { encryptInstagramToken, metaHomeUrl } from "@/lib/meta";

type DriveState = { owner_id: string; brand_id: string };
type TokenResult = { refresh_token?: string; error_description?: string };

export async function GET(request: Request) {
  if (!env.DB) return Response.redirect(metaHomeUrl("storage_unavailable"), 303);
  const callback = new URL(request.url);
  const state = callback.searchParams.get("state");
  if (!state || state.length > 160) return driveHome("invalid_state");
  let saved: DriveState | null;
  try {
    saved = await env.DB.prepare("DELETE FROM brand_drive_states WHERE state = ? AND expires_at > ? RETURNING owner_id, brand_id")
      .bind(state, Date.now()).first<DriveState>();
  } catch {
    return Response.redirect(metaHomeUrl("storage_unavailable"), 303);
  }
  if (!saved) return driveHome("invalid_state");
  if (callback.searchParams.has("error")) return driveHome("cancelled");
  const code = callback.searchParams.get("code");
  if (!code || !env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !env.INSTAGRAM_TOKEN_ENCRYPTION_KEY) return driveHome("config_missing");
  try {
    const redirectUri = new URL("/api/brands/drive/callback", request.url).toString();
    const response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, code, redirect_uri: redirectUri, grant_type: "authorization_code" }),
    });
    const token = await response.json() as TokenResult;
    if (!response.ok || !token.refresh_token) throw new Error(token.error_description ?? "Google no devolvió el permiso offline de Drive.");
    const encrypted = await encryptInstagramToken(token.refresh_token);
    await env.DB.prepare("UPDATE brand_registry SET drive_refresh_token = ?, updated_at = ? WHERE id = ? AND owner_id = ? AND active = 1")
      .bind(encrypted, Date.now(), saved.brand_id, saved.owner_id).run();
    return driveHome("connected");
  } catch (error) {
    console.error("Google Drive connection failed", error instanceof Error ? error.message.slice(0, 220) : "unknown error");
    return driveHome("connect_failed");
  }
}

function driveHome(result: string) {
  const origin = process.env.SITE_ORIGIN || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "https://social-studio.litodamm.chatgpt.site");
  const url = new URL("/", origin);
  url.searchParams.set("drive", result);
  return Response.redirect(url.toString(), 303);
}
