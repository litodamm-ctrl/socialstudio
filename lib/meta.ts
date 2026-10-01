import { env } from "@/lib/runtime";

const SITE_ORIGIN = new URL(env.SITE_ORIGIN || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "https://social-studio.litodamm.chatgpt.site")).origin;
const GRAPH_VERSION = env.META_GRAPH_VERSION || "v26.0";

export function instagramRedirectUri() {
  const configured = env.INSTAGRAM_REDIRECT_URI?.trim();
  const callback = configured || `${SITE_ORIGIN}/api/meta/callback`;
  const parsed = new URL(callback);
  if (
    parsed.protocol !== "https:" ||
    parsed.pathname !== "/api/meta/callback" ||
    parsed.search ||
    parsed.hash ||
    parsed.username ||
    parsed.password
  ) {
    throw new Error("INSTAGRAM_REDIRECT_URI must be the HTTPS callback URL for this app.");
  }
  return parsed.toString();
}

export function metaHomeUrl(result: string) {
  const url = new URL("/", SITE_ORIGIN);
  url.searchParams.set("meta", result);
  return url.toString();
}

export function graphUrl(path: string) {
  const trimmed = path.replace(/^\/+/, "");
  return `https://graph.instagram.com/${GRAPH_VERSION}/${trimmed}`;
}

export function randomUrlSafe(bytes = 32) {
  const buffer = crypto.getRandomValues(new Uint8Array(bytes));
  return base64Url(buffer);
}

function base64Url(value: Uint8Array) {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64ToBytes(value: string) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

async function encryptionKey() {
  const encoded = env.INSTAGRAM_TOKEN_ENCRYPTION_KEY;
  if (!encoded) throw new Error("Instagram token encryption key is not configured.");
  const bytes = base64ToBytes(encoded);
  if (bytes.byteLength !== 32) throw new Error("Instagram token encryption key must decode to 32 bytes.");
  return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function encryptInstagramToken(token: string) {
  const key = await encryptionKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(token);
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoded);
  return `${base64Url(iv)}.${base64Url(new Uint8Array(ciphertext))}`;
}

export async function decryptInstagramToken(value: string) {
  const [ivValue, ciphertextValue] = value.split(".");
  if (!ivValue || !ciphertextValue) throw new Error("Stored Instagram token is invalid.");
  const key = await encryptionKey();
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64ToBytes(ivValue) },
    key,
    base64ToBytes(ciphertextValue),
  );
  return new TextDecoder().decode(plaintext);
}

async function mediaUrlSigningKey() {
  const encoded = env.INSTAGRAM_TOKEN_ENCRYPTION_KEY;
  if (!encoded) throw new Error("Instagram media signing key is not configured.");
  const baseKey = await crypto.subtle.importKey("raw", base64ToBytes(encoded), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new TextEncoder().encode("social-studio"), info: new TextEncoder().encode("instagram-media-url-v1") },
    baseKey,
    { name: "HMAC", hash: "SHA-256", length: 256 },
    false,
    ["sign", "verify"],
  );
}

export async function signInstagramMediaUrl(id: string, expiresAt: number) {
  const signature = await crypto.subtle.sign(
    "HMAC",
    await mediaUrlSigningKey(),
    new TextEncoder().encode(`${id}:${expiresAt}`),
  );
  return base64Url(new Uint8Array(signature));
}

export async function verifyInstagramMediaUrl(id: string, expiresAt: number, signature: string) {
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now() || expiresAt > Date.now() + 3 * 60 * 60 * 1000) return false;
  try {
    return await crypto.subtle.verify(
      "HMAC",
      await mediaUrlSigningKey(),
      base64ToBytes(signature),
      new TextEncoder().encode(`${id}:${expiresAt}`),
    );
  } catch {
    return false;
  }
}

export async function instagramApiError(response: Response) {
  let message = "Instagram no aceptó la solicitud.";
  try {
    const data = await response.json() as { error?: { message?: string; type?: string; code?: number } };
    if (data.error?.message) message = data.error.message.slice(0, 240);
  } catch {
    // Keep the generic error when Meta does not return JSON.
  }
  return new Error(`Instagram API (${response.status}): ${message}`);
}
