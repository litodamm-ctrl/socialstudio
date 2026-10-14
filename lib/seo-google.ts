import { encryptInstagramToken, decryptInstagramToken } from "@/lib/meta";
import type { SeoSettings } from "@/lib/seo";

export function googleConfigured() {
  return Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.INSTAGRAM_TOKEN_ENCRYPTION_KEY && process.env.SITE_ORIGIN);
}
export function seoGoogleCallback() {
  const origin = new URL(process.env.SITE_ORIGIN!);
  if (origin.protocol !== "https:") throw new Error("Configura SITE_ORIGIN con HTTPS.");
  return new URL("/api/seo/google", origin.origin).href;
}
export async function storeGoogleToken(db: D1Database, owner: string, token: string) {
  await db.prepare("INSERT INTO seo_google (owner_id, refresh_token, connected_at) VALUES (?, ?, ?) ON CONFLICT(owner_id) DO UPDATE SET refresh_token = excluded.refresh_token, connected_at = excluded.connected_at")
    .bind(owner, await encryptInstagramToken(token), Date.now()).run();
}
async function accessToken(db: D1Database, owner: string) {
  const row = await db.prepare("SELECT refresh_token FROM seo_google WHERE owner_id = ?").bind(owner).first<{ refresh_token: string }>();
  if (!row) throw new Error("Conecta Google para consultar datos reales.");
  const response = await fetch("https://oauth2.googleapis.com/token", { method: "POST", signal: AbortSignal.timeout(15_000),
    body: new URLSearchParams({ client_id: process.env.GOOGLE_CLIENT_ID!, client_secret: process.env.GOOGLE_CLIENT_SECRET!, grant_type: "refresh_token", refresh_token: await decryptInstagramToken(row.refresh_token) }) });
  if (!response.ok) throw new Error("Reconecta Google; no se pudo renovar el acceso.");
  const data = await response.json() as { access_token?: string };
  if (!data.access_token) throw new Error("Google no entregó acceso.");
  return data.access_token;
}
async function google<T>(token: string, url: string, body?: unknown): Promise<T> {
  const response = await fetch(url, { method: body ? "POST" : "GET", signal: AbortSignal.timeout(20_000), cache: "no-store",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  if (!response.ok) throw new Error(`Google respondió HTTP ${response.status}. Verifica permisos, API habilitada y acceso aprobado a Google Business Profile.`);
  return response.json() as Promise<T>;
}
export async function googleResources(db: D1Database, owner: string) {
  const token = await accessToken(db, owner);
  const properties: Array<{ siteUrl: string; permissionLevel: string }> = [];
  const locations: Array<{ name: string; title: string; websiteUri?: string }> = [];
  const errors: string[] = [];
  try { const result = await google<{ siteEntry?: typeof properties }>(token, "https://www.googleapis.com/webmasters/v3/sites"); properties.push(...result.siteEntry ?? []); } catch (e) { errors.push(e instanceof Error ? e.message : "Search Console no disponible."); }
  try {
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
  try { token = await accessToken(db, owner); } catch (e) { result.errors.push(e instanceof Error ? e.message : "Conecta Google."); return result; }
  if (settings.search_property) {
    const end = new Date(Date.now() - 3 * 86400_000); const start = new Date(end.getTime() - 27 * 86400_000);
    result.period = { startDate: start.toISOString().slice(0, 10), endDate: end.toISOString().slice(0, 10) };
    try {
      result.search = await google(token, `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(settings.search_property)}/searchAnalytics/query`, { ...result.period, dimensions: ["query"], rowLimit: 30 });
    } catch (e) { result.errors.push(e instanceof Error ? e.message : "No se pudo leer Search Console."); }
  }
  if (settings.google_location) {
    const location = settings.google_location.split("/").slice(-2).join("/");
    try { result.business = await google(token, `https://mybusinessbusinessinformation.googleapis.com/v1/${location}?readMask=name,title,websiteUri,phoneNumbers,regularHours,categories,profile,storefrontAddress`); }
    catch (e) { result.errors.push(e instanceof Error ? e.message : "No se pudo leer Google Business."); }
  }
  return result;
}
