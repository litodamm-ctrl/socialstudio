const COOKIE_NAME = "social-studio-session";
const SESSION_AGE_SECONDS = 60 * 60 * 24 * 14;

function encode(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
function decode(value: string) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(normalized + "=".repeat((4 - normalized.length % 4) % 4));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}
function secretKey() {
  const value = process.env.AUTH_SECRET;
  if (!value || value.length < 32) throw new Error("AUTH_SECRET must contain at least 32 characters.");
  return crypto.subtle.importKey("raw", new TextEncoder().encode(value), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export async function issueSession(ownerId: string) {
  const payload = encode(new TextEncoder().encode(JSON.stringify({ sub: ownerId, exp: Math.floor(Date.now() / 1000) + SESSION_AGE_SECONDS })));
  const key = await secretKey();
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload)));
  return `${payload}.${encode(signature)}`;
}

export async function verifySession(value: string | undefined) {
  if (!value) return null;
  const [payload, signature, extra] = value.split(".");
  if (!payload || !signature || extra) return null;
  try {
    const key = await secretKey();
    const valid = await crypto.subtle.verify("HMAC", key, decode(signature), new TextEncoder().encode(payload));
    if (!valid) return null;
    const data = JSON.parse(new TextDecoder().decode(decode(payload))) as { sub?: string; exp?: number };
    if (!data.sub || !Number.isFinite(data.exp) || (data.exp ?? 0) <= Math.floor(Date.now() / 1000)) return null;
    if (data.sub !== process.env.SITE_OWNER_ID) return null;
    return { ownerId: data.sub };
  } catch {
    return null;
  }
}

export const sessionCookieName = COOKIE_NAME;
export const sessionAgeSeconds = SESSION_AGE_SECONDS;

