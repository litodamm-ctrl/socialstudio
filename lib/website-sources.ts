import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { isIP } from "node:net";

export function isPublicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b] = address.split(".").map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && [0, 168].includes(b))
      || (a === 100 && b >= 64 && b <= 127) || (a === 198 && [18, 19, 51].includes(b))
      || (a === 203 && b === 0));
  }
  // Only global unicast IPv6; exclude translation, documentation and tunnel ranges.
  const value = address.toLowerCase();
  return isIP(value) === 6 && /^[23]/.test(value) && !/^2001:|^2002:|^3fff:/.test(value);
}

function publicUrl(value: string): URL {
  const url = new URL(value);
  const host = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || url.username || url.password || url.port || !host.includes(".")
    || isIP(host) || host.includes(":") || /(?:^|\.)(?:localhost|local|internal|test|invalid)$/.test(host)) {
    throw new Error("Usa una dirección HTTPS pública, sin credenciales ni puertos.");
  }
  url.hash = "";
  return url;
}

export function normalizeWebsiteUrls(value: unknown): string[] {
  const items = typeof value === "string" ? value.split(/\r?\n/) : value;
  if (!Array.isArray(items) || items.some(item => typeof item !== "string")) throw new Error("Las webs deben ser una lista de direcciones HTTPS.");
  const urls = [...new Set(items.map(item => item.trim()).filter(Boolean).map(item => {
    if (item.length > 2048) throw new Error("La dirección web es demasiado larga.");
    return publicUrl(item).href;
  }))];
  if (urls.length > 10) throw new Error("Puedes agregar hasta 10 webs por marca.");
  return urls;
}

export function storedWebsiteUrls(json?: string | null, legacy?: string | null): string[] {
  if (json) {
    try { const urls = normalizeWebsiteUrls(JSON.parse(json)); if (urls.length) return urls; } catch { /* legacy compatibility */ }
  }
  try { return normalizeWebsiteUrls(legacy ? [legacy] : []); } catch { return []; }
}

export type PublicResource = { bytes: Buffer; url: string; contentType: string };
export function resolvePublicRedirect(location: string, origin: string): URL {
  return publicUrl(new URL(location, origin).href);
}
/** Resolve every redirect independently and pin the connection to a checked DNS answer. */
export async function fetchPublicResource(value: string, maxBytes = 512_000): Promise<PublicResource> {
  let url = publicUrl(value);
  const deadline = Date.now() + 12_000;
  for (let redirects = 0; redirects <= 3; redirects++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("La web tardó demasiado en responder.");
    const addresses = await Promise.race([
      lookup(url.hostname, { all: true }),
      new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(new Error("DNS timeout")), remaining); timer.unref(); }),
    ]);
    if (!addresses.length || addresses.some(item => !isPublicAddress(item.address))) throw new Error("La web apunta a una red privada o reservada.");
    const target = addresses[0];
    const result = await new Promise<PublicResource & { location?: string }>((resolve, reject) => {
      const req = request(url, {
        agent: false,
        family: target.family,
        headers: { Accept: "text/html,image/jpeg,image/png,image/webp", "Accept-Encoding": "identity", "User-Agent": "SocialStudio/1.0" },
        lookup: (_host, _options, callback) => callback(null, target.address, target.family),
      }, res => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode ?? 0) && res.headers.location) {
          res.destroy(); resolve({ bytes: Buffer.alloc(0), url: url.href, contentType: "", location: res.headers.location }); return;
        }
        if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) { res.destroy(); reject(new Error(`Web HTTP ${res.statusCode}`)); return; }
        const chunks: Buffer[] = []; let length = 0;
        res.on("data", (chunk: Buffer) => {
          length += chunk.length;
          if (length > maxBytes) { req.destroy(new Error("El recurso web supera el límite de tamaño.")); return; }
          chunks.push(chunk);
        });
        res.on("error", reject);
        res.on("end", () => resolve({ bytes: Buffer.concat(chunks), url: url.href, contentType: String(res.headers["content-type"] ?? "").split(";")[0].toLowerCase() }));
      });
      const timer = setTimeout(() => req.destroy(new Error("Web timeout")), Math.max(1, deadline - Date.now()));
      req.on("close", () => clearTimeout(timer));
      req.on("error", reject); req.end();
    });
    if (!result.location) return result;
    if (redirects === 3) throw new Error("Demasiadas redirecciones web.");
    url = resolvePublicRedirect(result.location, url.href);
  }
  throw new Error("No se pudo leer la web.");
}

function decode(value: string) {
  return value.replace(/&(?:amp|quot|apos|nbsp|lt|gt);|&#(?:x[\da-f]+|\d+);/gi, entity => {
    const named: Record<string, string> = { "&amp;": "&", "&quot;": '"', "&apos;": "'", "&nbsp;": " ", "&lt;": "<", "&gt;": ">" };
    if (named[entity.toLowerCase()]) return named[entity.toLowerCase()];
    const n = entity.toLowerCase().startsWith("&#x") ? parseInt(entity.slice(3), 16) : parseInt(entity.slice(2), 10);
    return Number.isFinite(n) && n <= 0x10ffff ? String.fromCodePoint(n) : "";
  });
}
export type WebsitePage = { url: string; title: string; text: string; images: string[] };
export function extractWebsitePage(html: string, url: string): WebsitePage {
  const clean = html.replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, " ").replace(/<!--[\s\S]*?-->/g, " ");
  const title = decode(clean.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "").replace(/<[^>]*>/g, " ").trim().slice(0, 200);
  const images: string[] = [];
  const add = (candidate: string) => { try { const result = publicUrl(new URL(decode(candidate), url).href).href; if (!images.includes(result)) images.push(result); } catch { /* unsafe or invalid image */ } };
  for (const match of clean.matchAll(/<(?:meta|img)\b[^>]*>/gi)) {
    const attributes: Record<string, string> = {};
    for (const attr of match[0].matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) attributes[attr[1].toLowerCase()] = attr[2] ?? attr[3] ?? attr[4];
    if (/^<meta/i.test(match[0]) && /^(?:og:image(?::secure_url)?|twitter:image)$/.test(attributes.property ?? attributes.name ?? "")) add(attributes.content ?? "");
    if (/^<img/i.test(match[0])) {
      for (const key of ["data-src", "src"]) if (attributes[key]) add(attributes[key]);
      for (const part of (attributes.srcset ?? "").split(",")) { const candidate = part.trim().split(/\s+/)[0]; if (candidate) add(candidate); }
    }
  }
  return { url, title, text: decode(clean.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim().slice(0, 10_000), images: images.slice(0, 20) };
}

export function selectWebsiteIndex(pages: Array<{ url: string; title?: string }>, brief: string, seed: string): number {
  if (!pages.length) return -1;
  const normalize = (text: string) => text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  const requestText = normalize(brief);
  const explicit = pages.findIndex(page => {
    const hostName = new URL(page.url).hostname.split(".")[0].replace(/[-_]/g, " ");
    const title = normalize(page.title ?? "").split(/[|–—:]/)[0].trim();
    return requestText.includes(normalize(page.url)) || (hostName.length >= 5 && hostName !== "www" && requestText.includes(normalize(hostName))) || (title.length >= 5 && requestText.includes(title));
  });
  if (explicit >= 0) return explicit;
  let hash = 0; for (const c of seed) hash = (Math.imul(hash, 31) + c.charCodeAt(0)) >>> 0;
  return hash % pages.length;
}

export async function inspectWebsite(url: string, read: typeof fetchPublicResource = fetchPublicResource): Promise<{ page: WebsitePage | null; error?: string }> {
  try {
    const resource = await read(url);
    if (!["text/html", "application/xhtml+xml", "text/plain"].includes(resource.contentType)) return { page: null, error: "La respuesta no es una página de texto o HTML." };
    const page = extractWebsitePage(resource.bytes.toString("utf8"), resource.url);
    if (page.text.length < 40) return { page: null, error: "La página no contiene texto suficiente; puede requerir JavaScript." };
    return { page };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    const message = error instanceof Error ? error.message : "Error de conexión";
    if (["EAI_AGAIN", "ENOTFOUND"].includes(code ?? "") || /DNS timeout/.test(message)) return { page: null, error: "No se pudo resolver el dominio (DNS)." };
    if (/timeout|tardó demasiado/i.test(message) || code === "ETIMEDOUT") return { page: null, error: "La web no respondió dentro del tiempo permitido." };
    if (/^Web HTTP \d+$/.test(message)) return { page: null, error: `El servidor respondió ${message.replace("Web ", "")}.` };
    if (/límite de tamaño|red privada|redirecciones/.test(message)) return { page: null, error: message };
    // Do not expose arbitrary upstream messages, credentials or response bodies.
    return { page: null, error: `No se pudo establecer la conexión segura${code && /^[A-Z_0-9]+$/.test(code) ? ` (${code})` : ""}.` };
  }
}

export async function loadWebsiteSource(urls: string[], brief: string, seed: string): Promise<WebsitePage | null> {
  if (!urls.length) return null;
  const pages: Array<WebsitePage | null> = Array(urls.length).fill(null);
  const errors: string[] = Array(urls.length).fill("");
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(3, urls.length) }, async () => {
    while (cursor < urls.length) { const index = cursor++;
      const result = await inspectWebsite(urls[index]);
      pages[index] = result.page;
      errors[index] = result.error ?? "";
    }
  }));
  const selected = selectWebsiteIndex(urls.map((url, index) => ({ url, title: pages[index]?.title })), brief, seed);
  if (!pages[selected]) throw new WebsiteSourceError(`${new URL(urls[selected]).hostname}: ${errors[selected] || "No se pudo leer la web del proyecto seleccionado."}`);
  return pages[selected];
}

export class WebsiteSourceError extends Error {}
