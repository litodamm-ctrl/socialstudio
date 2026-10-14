export type SeoFinding = { code: string; severity: "high" | "medium" | "low"; title: string; evidence: string; action: string };
export type SeoPage = { url: string; title: string; description: string; h1: string[]; score: number; findings: SeoFinding[]; checkedAt: number; error?: string };
function text(value: string) { return value.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim(); }
export function attributes(tag: string) {
  const result: Record<string, string> = {};
  for (const m of tag.matchAll(/([\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) result[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? "";
  return result;
}
export function analyzeSeo(html: string, url: string): SeoPage {
  const clean = html.replace(/<!--[\s\S]*?-->/g, "").replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, "");
  const title = text(clean.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "");
  const metas = Array.from(clean.matchAll(/<meta\b[^>]*>/gi), m => attributes(m[0]));
  const description = metas.find(m => m.name?.toLowerCase() === "description")?.content ?? "";
  const h1 = Array.from(clean.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi), m => text(m[1]));
  const links = Array.from(clean.matchAll(/<link\b[^>]*>/gi), m => attributes(m[0]));
  const images = Array.from(clean.matchAll(/<img\b[^>]*>/gi), m => attributes(m[0]));
  const findings: SeoFinding[] = [];
  const add = (code: string, severity: SeoFinding["severity"], title: string, evidence: string, action: string) => findings.push({ code, severity, title, evidence, action });
  if (!title) add("title-missing", "high", "Falta el título", "No hay un título en el HTML recibido.", "Redactar un título único que describa esta página y su marca.");
  else if (title.length > 65 || title.length < 15) add("title-length", "low", "Revisar el título", `${title.length} caracteres: ${title.slice(0, 200)}`, "Revisar claridad y longitud; Google puede reescribir o recortar el título.");
  if (!description) add("description-missing", "medium", "Falta la descripción", "No se encontró meta description.", "Preparar una descripción específica con el beneficio y una llamada a la acción.");
  if (!h1.length) add("h1-missing", "medium", "Falta el encabezado principal", "No se encontró H1 en el HTML.", "Añadir un encabezado descriptivo y visible para esta página.");
  if (h1.length > 1) add("h1-review", "low", "Revisar jerarquía de encabezados", `${h1.length} encabezados H1.`, "Comprobar que la jerarquía comunica con claridad el tema principal.");
  if (!links.some(l => l.rel?.toLowerCase().split(/\s+/).includes("canonical") && l.href)) add("canonical-missing", "medium", "Falta URL canónica", "No se encontró enlace canonical.", "Definir la URL preferida después de revisar variantes y duplicados.");
  const missingAlt = images.filter(i => !("alt" in i)).length;
  if (missingAlt) add("alt-missing", "medium", "Imágenes sin atributo alt", `${missingAlt} de ${images.length} imágenes.`, "Añadir texto alternativo a imágenes informativas; usar alt vacío en las decorativas.");
  if (metas.some(m => /^(robots|googlebot)$/i.test(m.name ?? "") && /\bnoindex\b/i.test(m.content ?? ""))) add("noindex", "high", "La página indica noindex", "Se detectó noindex en una metaetiqueta.", "Confirmar si esta página debe aparecer en Google antes de cambiar la directiva.");
  if (!metas.some(m => m.name?.toLowerCase() === "viewport")) add("viewport", "medium", "Revisar adaptación móvil", "No se encontró meta viewport.", "Añadir viewport y verificar la página en móvil.");
  if (!/<html\b[^>]*\blang\s*=\s*["']?[a-z]/i.test(clean)) add("lang", "low", "Idioma sin declarar", "No se encontró lang en html.", "Declarar el idioma principal del contenido.");
  if (!/<script\b[^>]*type\s*=\s*["']application\/ld\+json["']/i.test(html)) add("schema", "low", "Revisar datos estructurados", "No se detectó JSON-LD; no se comprobaron microdatos ni RDFa.", "Evaluar datos estructurados adecuados al negocio y validar su contenido.");
  const weights = { high: 20, medium: 10, low: 4 };
  return { url, title: title.slice(0, 500), description: description.slice(0, 1000), h1: h1.slice(0, 10), score: Math.max(0, 100 - findings.reduce((n, f) => n + weights[f.severity], 0)), findings, checkedAt: Date.now() };
}
