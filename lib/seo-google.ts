import { encryptInstagramToken, decryptInstagramToken } from "@/lib/meta";
import type { SeoSettings } from "@/lib/seo";
import { seoGoogleError } from "@/lib/seo-google-errors";

export function googleConfigured() {
  return Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.INSTAGRAM_TOKEN_ENCRYPTION_KEY && process.env.SITE_ORIGIN);
}
export function seoGoogleCallback() {
  try {
    const origin = new URL(process.env.SITE_ORIGIN!);
    if (origin.protocol !== "https:") throw new Error();
    return new URL("/api/seo/google", origin.origin).href;
  } catch { throw new Error("Configura SITE_ORIGIN con HTTPS."); }
}
export type GoogleCapabilities = { search: boolean | null; business: boolean | null; expired: boolean | null };
const GOOGLE_EXPIRED = "La autorización de Google caducó. Pulsa Reconectar Google.";

async function ensureGoogleCapabilities(db: D1Database) {
  await db.prepare(`CREATE TABLE IF NOT EXISTS seo_google_capabilities (
    owner_id TEXT PRIMARY KEY, search_scope INTEGER, business_scope INTEGER, refresh_expires_at INTEGER
  )`).run();
}
export async function storeGoogleToken(db: D1Database, owner: string, token: string, grantedScopes?: string, expiresIn?: number) {
  await ensureGoogleCapabilities(db);
  const now = Date.now();
  const scopes = typeof grantedScopes === "string" ? new Set(grantedScopes.trim().split(/\s+/)) : null;
  const search = scopes ? Number(scopes.has("https://www.googleapis.com/auth/webmasters.readonly") || scopes.has("https://www.googleapis.com/auth/webmasters")) : null;
  const business = scopes ? Number(scopes.has("https://www.googleapis.com/auth/business.manage")) : null;
  // This is the refresh token's supplied lifetime, never the access token's expires_in.
  const expiresAt = typeof expiresIn === "number" && Number.isSafeInteger(expiresIn) && expiresIn >= 0 && Number.isSafeInteger(now + expiresIn * 1000) ? now + expiresIn * 1000 : null;
  // Reconnection must replace the token and its capabilities together, including unknown metadata.
  await db.batch([
    db.prepare("INSERT INTO seo_google (owner_id, refresh_token, connected_at) VALUES (?, ?, ?) ON CONFLICT(owner_id) DO UPDATE SET refresh_token = excluded.refresh_token, connected_at = excluded.connected_at")
      .bind(owner, await encryptInstagramToken(token), now),
    db.prepare("INSERT INTO seo_google_capabilities (owner_id, search_scope, business_scope, refresh_expires_at) VALUES (?, ?, ?, ?) ON CONFLICT(owner_id) DO UPDATE SET search_scope = excluded.search_scope, business_scope = excluded.business_scope, refresh_expires_at = excluded.refresh_expires_at")
      .bind(owner, search, business, expiresAt),
  ]);
}
export async function googleCapabilities(db: D1Database, owner: string): Promise<GoogleCapabilities> {
  try {
    await ensureGoogleCapabilities(db);
    const row = await db.prepare("SELECT c.search_scope, c.business_scope, c.refresh_expires_at FROM seo_google_capabilities c JOIN seo_google g ON g.owner_id = c.owner_id WHERE g.owner_id = ?")
      .bind(owner).first<{ search_scope: number | null; business_scope: number | null; refresh_expires_at: number | null }>();
    const flag = (value: unknown) => value === 1 ? true : value === 0 ? false : null;
    return { search: flag(row?.search_scope), business: flag(row?.business_scope), expired: typeof row?.refresh_expires_at === "number" && Number.isSafeInteger(row.refresh_expires_at) && row.refresh_expires_at >= 0 ? row.refresh_expires_at <= Date.now() : null };
  } catch { throw new Error("No se pudieron comprobar los permisos de Google. Vuelve a cargar la conexión."); }
}
function selectedGoogleServices(capabilities: GoogleCapabilities, services: { search?: boolean; business?: boolean }, errors: string[]) {
  if (capabilities.expired === true) { errors.push(GOOGLE_EXPIRED); return { search: false, business: false }; }
  const selected = { search: Boolean(services.search), business: Boolean(services.business) };
  for (const service of ["search", "business"] as const) {
    if (selected[service] && capabilities[service] === false) {
      errors.push(`${service === "search" ? "Search Console" : "Google Business"}: falta el permiso OAuth. Pulsa Reconectar Google y concede acceso a este servicio.`);
      selected[service] = false;
    }
  }
  return selected;
}
async function accessToken(db: D1Database, owner: string, capabilities?: GoogleCapabilities) {
  if ((capabilities ?? await googleCapabilities(db, owner)).expired === true) throw new Error(GOOGLE_EXPIRED);
  const row = await db.prepare("SELECT refresh_token FROM seo_google WHERE owner_id = ?").bind(owner).first<{ refresh_token: string }>();
  if (!row) throw new Error("Conecta Google para consultar datos reales.");
  let response: Response;
  try {
    const refreshToken = await decryptInstagramToken(row.refresh_token);
    response = await fetch("https://oauth2.googleapis.com/token", { method: "POST", signal: AbortSignal.timeout(15_000), redirect: "error",
      body: new URLSearchParams({ client_id: process.env.GOOGLE_CLIENT_ID!, client_secret: process.env.GOOGLE_CLIENT_SECRET!, grant_type: "refresh_token", refresh_token: refreshToken }) });
  } catch { throw new Error("Reconecta Google; no se pudo renovar el acceso."); }
  if (!response.ok) throw new Error("Reconecta Google; no se pudo renovar el acceso.");
  const data = await response.json().catch(() => null) as { access_token?: string } | null;
  if (typeof data?.access_token !== "string" || !data.access_token.trim()) throw new Error("Google no entregó acceso.");
  return data.access_token;
}
async function googleResponse(token: string, url: string, body?: unknown, method: "GET" | "POST" | "PATCH" = body ? "POST" : "GET"): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(url, { method, signal: AbortSignal.timeout(20_000), cache: "no-store", redirect: "error",
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  } catch { throw new Error("No se pudo contactar con Google. Vuelve a cargar los datos antes de reintentar."); }
  if (!response.ok) {
    const host = new URL(url).hostname;
    let message = seoGoogleError(response.status, host, {});
    try { message = seoGoogleError(response.status, host, await response.json()); }
    catch { /* Non-JSON or malformed errors still receive a sanitized status message. */ }
    throw new Error(message);
  }
  return response;
}
async function google<T>(token: string, url: string, body?: unknown): Promise<T> {
  const response = await googleResponse(token, url, body);
  try { return await response.json() as T; }
  catch { throw new Error("Google devolvió una respuesta no válida. Vuelve a cargar los datos antes de reintentar."); }
}

const BUSINESS_INFORMATION_URL = "https://mybusinessbusinessinformation.googleapis.com/v1/";

function businessLocationName(location: string): string {
  const match = typeof location === "string" ? /^accounts\/[A-Za-z0-9_-]+\/(locations\/[A-Za-z0-9_-]+)$/.exec(location) : null;
  if (!match || match[0] !== location) throw new Error("Selecciona una ubicación válida de Google Business.");
  return match[1];
}

export function validateGoogleBusinessDescription(description: string): string {
  if (typeof description !== "string") throw new Error("La descripción debe ser texto plano.");
  const value = description.trim();
  if (value.length > 750) throw new Error("La descripción de Google Business no puede superar los 750 caracteres.");
  const hasControlCharacters = [...value].some(char => {
    const code = char.charCodeAt(0);
    return (code < 32 && ![9, 10, 13].includes(code)) || code === 127;
  });
  const hasLink = /[a-z][a-z0-9+.-]*:\/\/|\/\/\S|\b(?:https?|mailto|tel|sms|data|javascript):|\bwww\.|\[[^\]]*\]\s*\([^)]*\)/i.test(value)
    || /(?:[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?\.)+(?:[\p{L}]{2,63}|xn--[a-z0-9-]+)(?=$|[^\p{L}\p{N}-])/iu.test(value);
  if (/[<>]/.test(value) || hasControlCharacters || hasLink) throw new Error("La descripción debe ser texto plano, sin HTML, signos < o > ni enlaces.");
  return value;
}

async function businessDescriptionWithToken(token: string, name: string): Promise<string> {
  const data = await google<{ name?: string; profile?: { description?: string } }>(token, `${BUSINESS_INFORMATION_URL}${name}?readMask=name,profile`);
  if (!data || data.name !== name || (data.profile !== undefined && (
    !data.profile || typeof data.profile !== "object" || Array.isArray(data.profile)
    || (data.profile.description !== undefined && typeof data.profile.description !== "string")
  ))) throw new Error("No se pudo leer la descripción de Google Business de forma fiable. Vuelve a cargar el perfil antes de guardar.");
  return data.profile?.description ?? "";
}

export async function readGoogleBusinessDescription(db: D1Database, owner: string, location: string): Promise<string> {
  const name = businessLocationName(location);
  return businessDescriptionWithToken(await accessToken(db, owner), name);
}

export async function updateGoogleBusinessDescription(db: D1Database, owner: string, location: string, description: string, expected: string): Promise<{ description: string }> {
  const name = businessLocationName(location);
  const desired = validateGoogleBusinessDescription(description);
  if (typeof expected !== "string") throw new Error("Vuelve a leer la descripción actual de Google Business antes de guardar.");
  const token = await accessToken(db, owner);
  const current = await businessDescriptionWithToken(token, name);
  if (current === desired) return { description: current };
  // Compare the exact value read earlier; trimming expected could conceal another edit.
  if (current !== expected) throw new Error("La descripción de Google Business cambió en otro lugar. Vuelve a cargarla y revisa los cambios antes de guardar; no se ha sobrescrito.");

  const uncertain = "No se pudo confirmar que Google Business haya guardado la descripción. El cambio puede estar pendiente o su resultado es incierto. Vuelve a leer el perfil de Google Business antes de reintentar.";
  let persisted: string;
  try {
    await googleResponse(token, `${BUSINESS_INFORMATION_URL}${name}?updateMask=profile.description`, { name, profile: { description: desired } }, "PATCH");
    persisted = await businessDescriptionWithToken(token, name);
  } catch (error) {
    // Only locally generated, sanitized Google diagnostics reach this boundary.
    throw new Error(`${uncertain}${error instanceof Error ? ` ${error.message}` : ""}`);
  }
  if (persisted !== desired) throw new Error(uncertain);
  // Read-back confirms API persistence, not public visibility on Maps or Search.
  return { description: persisted };
}

export async function googleResources(db: D1Database, owner: string, services: { search?: boolean; business?: boolean } = { search: true, business: true }) {
  const properties: Array<{ siteUrl: string; permissionLevel: string }> = [];
  const locations: Array<{ name: string; title: string; websiteUri?: string }> = [];
  const errors: string[] = [];
  if (!services.search && !services.business) return { properties, locations, errors };
  const capabilities = await googleCapabilities(db, owner);
  const selected = selectedGoogleServices(capabilities, services, errors);
  if (!selected.search && !selected.business) return { properties, locations, errors };
  const token = await accessToken(db, owner, capabilities);
  if (selected.search) {
    try { const result = await google<{ siteEntry?: typeof properties }>(token, "https://www.googleapis.com/webmasters/v3/sites"); properties.push(...result.siteEntry ?? []); } catch (e) { errors.push(e instanceof Error ? e.message : "Search Console no disponible."); }
  }
  if (selected.business) try {
    let pageToken = "";
    do {
      const accounts = await google<{ accounts?: Array<{ name: string }>; nextPageToken?: string }>(token, `https://mybusinessaccountmanagement.googleapis.com/v1/accounts?pageSize=20${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`);
      for (const account of accounts.accounts ?? []) {
        let locationToken = "";
        do {
          const data = await google<{ locations?: Array<{ name: string; title: string; websiteUri?: string }>; nextPageToken?: string }>(token, `https://mybusinessbusinessinformation.googleapis.com/v1/${account.name}/locations?readMask=name,title,websiteUri&pageSize=100${locationToken ? `&pageToken=${encodeURIComponent(locationToken)}` : ""}`);
          for (const location of data.locations ?? []) locations.push({ ...location, name: `${account.name}/${location.name}` });
          locationToken = data.nextPageToken ?? "";
        } while (locationToken);
      }
      pageToken = accounts.nextPageToken ?? "";
    } while (pageToken);
  } catch (e) { errors.push(e instanceof Error ? e.message : "Google Business no disponible."); }
  return { properties, locations, errors };
}
export async function googleSnapshot(db: D1Database, owner: string, settings: SeoSettings) {
  const result: { search?: unknown; business?: unknown; errors: string[]; period?: { startDate: string; endDate: string } } = { errors: [] };
  if (!settings.search_property && !settings.google_location) { result.errors.push("Vincula una propiedad de Search Console y/o una ubicación de Google Business para esta marca."); return result; }
  let token: string;
  let selected: { search: boolean; business: boolean };
  try {
    const capabilities = await googleCapabilities(db, owner);
    selected = selectedGoogleServices(capabilities, { search: Boolean(settings.search_property), business: Boolean(settings.google_location) }, result.errors);
    if (!selected.search && !selected.business) return result;
    token = await accessToken(db, owner, capabilities);
  } catch (e) { result.errors.push(e instanceof Error ? e.message : "Conecta Google."); return result; }
  if (selected.search) {
    const end = new Date(Date.now() - 3 * 86400_000); const start = new Date(end.getTime() - 27 * 86400_000);
    result.period = { startDate: start.toISOString().slice(0, 10), endDate: end.toISOString().slice(0, 10) };
    try {
      result.search = await google(token, `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(settings.search_property)}/searchAnalytics/query`, { ...result.period, dimensions: ["query"], rowLimit: 30 });
    } catch (e) { result.errors.push(e instanceof Error ? e.message : "No se pudo leer Search Console."); }
  }
  if (selected.business) {
    const location = settings.google_location.split("/").slice(-2).join("/");
    try { result.business = await google(token, `https://mybusinessbusinessinformation.googleapis.com/v1/${location}?readMask=name,title,websiteUri,phoneNumbers,regularHours,categories,profile,storefrontAddress`); }
    catch (e) { result.errors.push(e instanceof Error ? e.message : "No se pudo leer Google Business."); }
  }
  return result;
}
