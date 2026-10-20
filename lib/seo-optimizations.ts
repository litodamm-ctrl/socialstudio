import { createHash } from "node:crypto";
import { createSeoPullRequest, githubConfigured, parseGithubTargets, type SeoGithubTarget } from "@/lib/seo-github";
import { readGoogleBusinessDescription, updateGoogleBusinessDescription, validateGoogleBusinessDescription } from "@/lib/seo-google";
import { analyzeSeo, type SeoPage } from "@/lib/seo-audit";
import { fetchPublicResource, MAX_WEBSITE_BYTES, storedWebsiteUrls } from "@/lib/website-sources";

export type SeoProposal = {
  id: string; owner_id: string; brand_id: string; run_id: string; kind: "github" | "google";
  target: string; title: string; description: string; before_value: string;
  status: string; created_at: number; updated_at: number; result_url: string; error: string;
  destination: string; attempt: string;
};
export type SeoDelivery = { githubTargets: SeoGithubTarget[]; autoPr: boolean; githubConfigured: boolean; revision: number };
type Brand = { id: string; owner_id: string; name: string; website_urls: string; website_url: string };
export type SeoSuggestion = { url: string; title: string; description: string };
export const seoOutputFormat = {
  type: "json_schema", name: "seo_plan", strict: true,
  schema: { type: "object", additionalProperties: false, properties: {
    plan: { type: "string" },
    pages: { type: "array", items: { type: "object", additionalProperties: false, properties: {
      url: { type: "string" }, title: { type: "string" }, description: { type: "string" },
    }, required: ["url", "title", "description"] } },
    businessDescription: { type: "string" },
  }, required: ["plan", "pages", "businessDescription"] },
};
export function proposalText(value: unknown, max: number, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && !value.trim()) || value.trim().length > max || /[<>\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) throw new Error(`Revisa el texto propuesto (máximo ${max} caracteres, sin HTML).`);
  return value.trim();
}
export function parseSeoPlan(content: string, pages: SeoPage[], hasBusiness: boolean) {
  const data = JSON.parse(content) as { plan?: unknown; pages?: unknown; businessDescription?: unknown };
  if (typeof data.plan !== "string" || !data.plan.trim() || !Array.isArray(data.pages)) throw new Error("El plan no tiene el formato esperado.");
  const accepted: SeoSuggestion[] = [];
  for (const item of data.pages.slice(0, 10) as SeoSuggestion[]) {
    if (!item || !pages.some(p => !p.error && p.url === item.url) || accepted.some(p => p.url === item.url)) continue;
    try { accepted.push({ url: item.url, title: proposalText(item.title, 150), description: proposalText(item.description, 320) }); } catch { /* Discard invalid suggestions, retain the audit. */ }
  }
  let businessDescription = "";
  if (hasBusiness) { try { businessDescription = validateGoogleBusinessDescription(proposalText(data.businessDescription, 750)); } catch {} }
  return { text: data.plan.trim().slice(0, 16000), pages: accepted, businessDescription };
}
export async function ensureSeoOptimizations(db: D1Database) {
  await db.prepare(`CREATE TABLE IF NOT EXISTS seo_delivery (
    brand_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, github_targets TEXT NOT NULL DEFAULT '[]', auto_pr INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL DEFAULT 0
  )`).run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS seo_proposals (
    id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, brand_id TEXT NOT NULL, run_id TEXT NOT NULL,
    kind TEXT NOT NULL, target TEXT NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL,
    before_value TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'draft',
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, result_url TEXT NOT NULL DEFAULT '',
    error TEXT NOT NULL DEFAULT '', destination TEXT NOT NULL DEFAULT '', attempt TEXT NOT NULL DEFAULT ''
  )`).run();
  await db.prepare("CREATE TABLE IF NOT EXISTS seo_resource_leases (resource_key TEXT PRIMARY KEY, attempt TEXT NOT NULL, lease_until INTEGER NOT NULL)").run();
  await db.prepare("CREATE INDEX IF NOT EXISTS seo_proposals_brand ON seo_proposals(owner_id, brand_id, created_at)").run();
  await db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS seo_proposals_inflight ON seo_proposals(owner_id, brand_id, kind, target) WHERE status IN ('queued','processing','pr_created')").run();
}
export async function deliverySettings(db: D1Database, brand: Brand): Promise<SeoDelivery> {
  const row = await db.prepare("SELECT github_targets, auto_pr, revision FROM seo_delivery WHERE brand_id = ? AND owner_id = ?").bind(brand.id, brand.owner_id).first<{ github_targets: string; auto_pr: number; revision: number }>();
  let targets: SeoGithubTarget[] = [];
  try { targets = parseGithubTargets(JSON.parse(row?.github_targets ?? "[]"), storedWebsiteUrls(brand.website_urls, brand.website_url)); } catch { /* A removed website invalidates its old destination. */ }
  return { githubTargets: targets, autoPr: Boolean(row?.auto_pr), githubConfigured: githubConfigured(), revision: row?.revision ?? 0 };
}
export async function listSeoProposals(db: D1Database, owner: string, brand: string) {
  const rows = await db.prepare("SELECT * FROM seo_proposals WHERE owner_id = ? AND brand_id = ? ORDER BY created_at DESC, id LIMIT 60").bind(owner, brand).all<SeoProposal>();
  return rows.results ?? [];
}
export async function saveSeoProposals(db: D1Database, brand: Brand, runId: string, pages: SeoPage[], suggestions: SeoSuggestion[], business: { location: string; before: string; description: string } | null) {
  const now = Date.now();
  const items = suggestions.map(p => ({ kind: "github", target: p.url, title: p.title, description: p.description, before: JSON.stringify({ title: pages.find(a => a.url === p.url)?.title ?? "", description: pages.find(a => a.url === p.url)?.description ?? "" }) }));
  if (business?.description) items.push({ kind: "google", target: business.location, title: "Descripción de Google Business", description: business.description, before: business.before });
  for (const item of items) {
    const id = createHash("sha256").update(`${runId}\n${item.kind}\n${item.target}`).digest("hex");
    await db.prepare("INSERT OR IGNORE INTO seo_proposals (id, owner_id, brand_id, run_id, kind, target, title, description, before_value, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(id, brand.owner_id, brand.id, runId, item.kind, item.target, item.title, item.description, item.before, now, now).run();
  }
}
export async function queueSeoProposal(db: D1Database, brand: Brand, id: string, automatic = false) {
  const item = await db.prepare("SELECT * FROM seo_proposals WHERE id = ? AND owner_id = ? AND brand_id = ?").bind(id, brand.owner_id, brand.id).first<SeoProposal>();
  if (!item) throw new Error("Propuesta no encontrada.");
  if (Date.now() - item.created_at > 7 * 86400_000) throw new Error("La propuesta tiene más de siete días. Ejecuta una nueva auditoría.");
  let destination = "";
  let revision = -1;
  if (item.kind === "github") {
    const delivery = await deliverySettings(db, brand);
    if (!delivery.githubConfigured) throw new Error("Conecta GitHub: configura SEO_GITHUB_TOKEN en Netlify con acceso a los repositorios de estas webs.");
    const target = delivery.githubTargets.find(t => t.url === item.target);
    if (!target) throw new Error("Asocia esta web con su repositorio y archivo HTML en Destinos de las mejoras.");
    destination = JSON.stringify(target);
    if (item.destination && item.destination !== destination) throw new Error("El destino original de este envío cambió. Revisa el repositorio anterior y prepara una nueva propuesta; este reintento no se enviará a otro repositorio.");
    revision = delivery.revision;
  } else {
    const config = await db.prepare("SELECT google_location FROM seo_settings WHERE brand_id = ? AND owner_id = ?").bind(brand.id, brand.owner_id).first<{ google_location: string }>();
    if (!config?.google_location || config.google_location !== item.target) throw new Error("La ficha vinculada cambió. Ejecuta una nueva auditoría.");
  }
  const claimed = await db.prepare(`UPDATE seo_proposals SET status = 'queued', destination = ?, error = '', updated_at = ? WHERE id = ? AND owner_id = ? AND brand_id = ? AND status IN ('draft','failed')
    AND (? = -1 OR EXISTS (SELECT 1 FROM seo_delivery d WHERE d.brand_id = seo_proposals.brand_id AND d.owner_id = seo_proposals.owner_id AND d.revision = ? AND (? = 0 OR d.auto_pr = 1))) RETURNING id`)
    .bind(destination, Date.now(), id, brand.owner_id, brand.id, revision, revision, automatic ? 1 : 0).first();
  if (!claimed) throw new Error("La propuesta ya se envió o su configuración cambió. Actualiza antes de continuar.");
}
export async function processSeoProposal(db: D1Database, id: string) {
  const attempt = crypto.randomUUID();
  const item = await db.prepare("UPDATE seo_proposals SET status = 'processing', attempt = ?, updated_at = ? WHERE id = ? AND status = 'queued' RETURNING *").bind(attempt, Date.now(), id).first<SeoProposal>();
  if (!item) return;
  let resourceKey = "";
  try {
    const brand = await db.prepare("SELECT id, owner_id, name, website_url, website_urls FROM brand_registry WHERE id = ? AND owner_id = ? AND active = 1").bind(item.brand_id, item.owner_id).first<Brand>();
    if (!brand) throw new Error("La marca ya no está activa.");
    const destination = item.kind === "github" ? parseGithubTargets([JSON.parse(item.destination)], storedWebsiteUrls(brand.website_urls, brand.website_url))[0] : null;
    resourceKey = destination ? `github:${destination.repository}:${destination.branch}:${destination.path}` : `google:${item.target.split('/').slice(-2).join('/')}`;
    const lease = await db.prepare("INSERT INTO seo_resource_leases (resource_key,attempt,lease_until) VALUES (?,?,?) ON CONFLICT(resource_key) DO UPDATE SET attempt=excluded.attempt, lease_until=excluded.lease_until WHERE seo_resource_leases.lease_until < ? RETURNING resource_key")
      .bind(resourceKey, attempt, Date.now() + 15 * 60_000, Date.now()).first();
    if (!lease) throw new Error("Otra marca está enviando una mejora al mismo destino. Espera y vuelve a comprobar la propuesta.");
    let url = "";
    if (item.kind === "github") {
      const target = destination!;
      const current = await deliverySettings(db, brand);
      if (!current.githubTargets.some(t => JSON.stringify(t) === JSON.stringify(target))) throw new Error("El destino cambió desde que se envió. Vuelve a revisar la propuesta.");
      // A previous run may already have an open proposal for the same page.
      const existing = await db.prepare("SELECT id FROM seo_proposals WHERE owner_id = ? AND brand_id = ? AND target = ? AND status = 'pr_created' AND id != ? LIMIT 1").bind(item.owner_id, item.brand_id, item.target, item.id).first();
      if (existing) throw new Error("Esta página ya tiene una propuesta en GitHub pendiente de verificar. Comprueba su publicación antes de crear otra.");
      const expected = JSON.parse(item.before_value) as { title: string; description: string };
      const result = await createSeoPullRequest({ target, title: item.title, description: item.description, expected, runId: item.run_id, brandName: brand.name });
      url = result.url;
    } else {
      const config = await db.prepare("SELECT google_location FROM seo_settings WHERE brand_id = ? AND owner_id = ?").bind(brand.id, brand.owner_id).first<{ google_location: string }>();
      if (config?.google_location !== item.target) throw new Error("La ficha vinculada cambió. Revisa la conexión.");
      await updateGoogleBusinessDescription(db, item.owner_id, item.target, item.description, item.before_value);
    }
    await db.prepare("UPDATE seo_proposals SET status = ?, result_url = ?, error = '', updated_at = ? WHERE id = ? AND attempt = ? AND status = 'processing'")
      .bind(item.kind === "github" ? "pr_created" : "applied", url, Date.now(), id, attempt).run();
  } catch (e) {
    const error = e instanceof Error ? e.message.slice(0, 500) : "No se pudo enviar la propuesta. Revisa el destino antes de reintentar.";
    await db.prepare("UPDATE seo_proposals SET status = 'failed', error = ?, updated_at = ? WHERE id = ? AND attempt = ? AND status = 'processing'").bind(error, Date.now(), id, attempt).run();
  } finally {
    if (resourceKey) await db.prepare("DELETE FROM seo_resource_leases WHERE resource_key = ? AND attempt = ?").bind(resourceKey, attempt).run();
  }
}
export async function autoQueueSeoProposals(db: D1Database, brand: Brand, runId: string) {
  const delivery = await deliverySettings(db, brand);
  if (!delivery.autoPr || !delivery.githubConfigured) return;
  const rows = await db.prepare("SELECT id, target FROM seo_proposals WHERE owner_id = ? AND brand_id = ? AND run_id = ? AND kind = 'github' AND status = 'draft'").bind(brand.owner_id, brand.id, runId).all<{ id: string; target: string }>();
  for (const item of rows.results ?? []) {
    if (!delivery.githubTargets.some(t => t.url === item.target)) continue;
    try { await queueSeoProposal(db, brand, item.id, true); await processSeoProposal(db, item.id); }
    catch { /* An unavailable destination does not erase the audit or its proposal. */ }
  }
}
export async function verifySeoProposal(db: D1Database, owner: string, brand: Brand, id: string) {
  const item = await db.prepare("SELECT * FROM seo_proposals WHERE id = ? AND owner_id = ? AND brand_id = ?").bind(id, owner, brand.id).first<SeoProposal>();
  if (item?.kind === "google" && ["failed", "applied"].includes(item.status)) {
    // Read-only reconciliation remains available even after the seven-day write
    // window, so an uncertain delivery can still be confirmed and restored.
    const config = await db.prepare("SELECT google_location FROM seo_settings WHERE brand_id = ? AND owner_id = ?").bind(brand.id, owner).first<{ google_location: string }>();
    if (config?.google_location !== item.target) throw new Error("La ficha vinculada cambió. Revisa la conexión antes de comprobar el envío.");
    const current = await readGoogleBusinessDescription(db, owner, item.target);
    if (current !== item.description) throw new Error("Google todavía no devuelve esta descripción. No se ha escrito nada: revisa el perfil y el error original antes de reintentar.");
    await db.prepare("UPDATE seo_proposals SET status = 'applied', error = '', updated_at = ? WHERE id = ? AND owner_id = ? AND brand_id = ? AND status IN ('failed','applied')").bind(Date.now(), id, owner, brand.id).run();
    return;
  }
  if (!item || item.kind !== "github" || !["pr_created", "verified"].includes(item.status)) throw new Error("Envía primero la propuesta a GitHub.");
  if (!storedWebsiteUrls(brand.website_urls, brand.website_url).includes(item.target)) throw new Error("Esta web ya no pertenece a la marca.");
  const resource = await fetchPublicResource(item.target, MAX_WEBSITE_BYTES);
  if (!["text/html", "application/xhtml+xml"].includes(resource.contentType)) throw new Error("La web no devolvió HTML.");
  const page = analyzeSeo(resource.bytes.toString("utf8"), resource.url, resource.headers);
  if (page.title !== item.title || page.description !== item.description) throw new Error("La web todavía no muestra estos textos. Revisa la propuesta y el despliegue en GitHub/Netlify.");
  await db.prepare("UPDATE seo_proposals SET status = 'verified', error = '', updated_at = ? WHERE id = ? AND owner_id = ? AND brand_id = ?").bind(Date.now(), id, owner, brand.id).run();
}
