"use client";

import { useCallback, useEffect, useState } from "react";
import { Globe, Search, Sparkles, RefreshCw, Link2, CheckCircle2, AlertCircle, Clock3 } from "lucide-react";
import type { SeoPage } from "@/lib/seo-audit";
import styles from "./seo-studio.module.css";

type Brand = { id: string; name: string; color: string; initials: string; website_url: string; website_urls: string };
type Settings = { enabled: number; cadence: string; keywords: string; location: string; search_property: string; google_location: string };
type Report = { score: number | null; pages: SeoPage[]; scope: string; agent: { text: string; status: string }; google: { errors: string[]; period?: { startDate: string; endDate: string }; search?: { rows?: Array<{ keys: string[]; clicks: number; impressions: number; ctr: number; position: number }> }; business?: { title?: string; websiteUri?: string; profile?: { description?: string }; categories?: { primaryCategory?: { displayName?: string } }; phoneNumbers?: { primaryPhone?: string }; regularHours?: unknown } } };
type Run = { id: string; status: string; started_at: number; report: Report | null; error: string | null };
type Data = { brands: Brand[]; settings: Settings | null; runs: Run[]; google: { connected: boolean; configured: boolean }; agent: boolean; scheduler: boolean };
type Resources = { properties: Array<{ siteUrl: string }>; locations: Array<{ name: string; title: string; websiteUri?: string }>; errors: string[] };
const initial: Settings = { enabled: 0, cadence: "weekly", keywords: "", location: "Cartagena de Indias", search_property: "", google_location: "" };
const date = (value: number) => new Date(value).toLocaleString("es-CO", { timeZone: "America/Bogota", dateStyle: "medium", timeStyle: "short" });
async function read<T>(response: Response): Promise<T> { const data = await response.json() as { error?: string }; if (!response.ok) throw new Error(data.error ?? "No se pudo completar la solicitud."); return data as T; }

export default function SeoStudio({ manageBrands }: { manageBrands: () => void }) {
  const [data, setData] = useState<Data | null>(null);
  const [brandId, setBrandId] = useState("");
  const [settings, setSettings] = useState(initial);
  const [resources, setResources] = useState<Resources | null>(null);
  const [busy, setBusy] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [historyId, setHistoryId] = useState("");
  const load = useCallback(async (signal?: AbortSignal) => read<Data>(await fetch(`/api/seo${brandId ? `?brandId=${encodeURIComponent(brandId)}` : ""}`, { signal, cache: "no-store" })), [brandId]);
  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setError(""); setMessage(""); setHistoryId("");
    void load(controller.signal).then(result => { setData(result); setSettings(result.settings ?? initial); if (!brandId && result.brands.length) setBrandId(result.brands[0].id); }).catch(e => { if (!controller.signal.aborted) setError(e.message); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [load, brandId]);
  const refresh = useCallback(async () => { setData(await load()); }, [load]);
  const running = data?.runs.some(r => ["queued", "running"].includes(r.status)) ?? false;
  useEffect(() => {
    if (!running) return;
    const controller = new AbortController();
    const timer = setInterval(() => { void load(controller.signal).then(setData).catch(() => {}); }, 6000);
    return () => { clearInterval(timer); controller.abort(); };
  }, [running, load]);
  async function act(action: string) {
    setBusy(action); setError(""); setMessage("");
    try {
      await read(await fetch("/api/seo", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action, brandId, enabled: Boolean(settings.enabled), cadence: settings.cadence, keywords: settings.keywords, location: settings.location, searchProperty: settings.search_property, googleLocation: settings.google_location }) }));
      setMessage(action === "save" ? "Configuración guardada para esta marca." : "Auditoría iniciada. Puedes seguir usando Social Studio.");
      setHistoryId(""); await refresh();
    } catch (e) { setError(e instanceof Error ? e.message : "No se pudo completar la acción."); }
    finally { setBusy(""); }
  }
  async function connect() {
    setBusy("google"); setError("");
    try { const response = await read<{ url: string }>(await fetch("/api/seo/google")); window.location.assign(response.url); }
    catch (e) { setError(e instanceof Error ? e.message : "No se pudo conectar."); setBusy(""); }
  }
  async function listResources() {
    setBusy("resources"); setError("");
    try { setResources(await read<Resources>(await fetch("/api/seo/google?action=resources", { cache: "no-store" }))); }
    catch (e) { setError(e instanceof Error ? e.message : "No se pudieron cargar las propiedades."); }
    finally { setBusy(""); }
  }
  async function disconnect() {
    setBusy("disconnect"); setError("");
    try { await read(await fetch("/api/seo/google", { method: "DELETE" })); setResources(null); setSettings(s => ({ ...s, search_property: "", google_location: "" })); await refresh(); setMessage("Google desconectado. Las auditorías web siguen disponibles."); }
    catch (e) { setError(e instanceof Error ? e.message : "No se pudo desconectar."); }
    finally { setBusy(""); }
  }
  const brand = data?.brands.find(b => b.id === brandId);
  const run = data?.runs.find(r => r.id === historyId) ?? data?.runs[0];
  const report = run?.report;
  const findings = report?.pages.reduce((n, p) => n + p.findings.length, 0) ?? 0;
  return <div className={styles.studio}>
    <header className={styles.heading}><div><div className={styles.kicker}>CRECIMIENTO ORGÁNICO · POR MARCA</div><h1>SEO y Google</h1><p>Un agente que revisa tu presencia y prepara el próximo paso.</p></div><button className="secondary-button" onClick={manageBrands}>Gestionar marcas</button></header>
    <div className={styles.brandbar}><label htmlFor="seo-brand">Tu marca</label><select id="seo-brand" value={brandId} disabled={Boolean(busy)} onChange={e => { setData(null); setBrandId(e.target.value); }}><option value="" disabled>Selecciona una marca</option>{data?.brands.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}</select><button onClick={() => { setError(""); void refresh().catch(e => setError(e.message)); }} disabled={loading || Boolean(busy)} aria-label="Actualizar SEO"><RefreshCw size={16} /></button></div>
    {error && <div role="alert" className={styles.error}><AlertCircle size={18} />{error}</div>}
    {message && <div role="status" className={styles.notice}><CheckCircle2 size={18} />{message}</div>}
    {loading && <p role="status">Cargando la información SEO…</p>}
    {!loading && !data && <button className="secondary-button" onClick={() => void refresh().catch(e => setError(e.message))}>Reintentar</button>}
    {data && brand && !loading && <>
      <section className={styles.stats} aria-label="Estado SEO"><div><Globe size={19} /><span>Salud del HTML</span><strong>{report?.score == null ? "Sin medir" : `${report.score}/100`}</strong><small>Puntaje interno; no es una posición en Google</small></div><div><Search size={19} /><span>Hallazgos</span><strong>{report ? findings : "—"}</strong><small>{report ? `${report.pages.length} URL revisadas` : "Ejecuta tu primera auditoría"}</small></div><div><Sparkles size={19} /><span>Agente de {brand.name}</span><strong>{settings.enabled ? "Programado" : "Manual"}</strong><small>{data.agent ? "IA disponible" : "OpenAI pendiente de configurar"}</small></div></section>
      <div className={styles.columns}><section className={styles.card}><div className={styles.cardhead}><Sparkles size={20} /><h2>Agente de la marca</h2></div><p>Usa la esencia y las webs guardadas en Social Studio. Automatiza la revisión y prepara propuestas; los cambios en tus webs y perfiles aún no se aplican desde aquí.</p>
        <fieldset disabled={Boolean(busy)} className={styles.fields}>
          <label htmlFor="seo-location">Ciudad o mercado principal<input id="seo-location" value={settings.location} maxLength={200} onChange={e => setSettings({ ...settings, location: e.target.value })} /></label>
          <label htmlFor="seo-keywords">Búsquedas que te interesan<textarea id="seo-keywords" rows={3} maxLength={2000} value={settings.keywords} onChange={e => setSettings({ ...settings, keywords: e.target.value })} placeholder="Por ejemplo: tortas en Cartagena, pedidos de cumpleaños…" /></label>
          <label className={styles.toggle}><input type="checkbox" checked={Boolean(settings.enabled)} onChange={e => setSettings({ ...settings, enabled: e.target.checked ? 1 : 0 })} /><span>Activar auditorías automáticas</span></label>
          <label htmlFor="seo-cadence">Frecuencia<select id="seo-cadence" value={settings.cadence} onChange={e => setSettings({ ...settings, cadence: e.target.value })}><option value="daily">Diaria</option><option value="weekly">Semanal</option></select></label>
        </fieldset>
        {!data.scheduler && <div className={styles.warning}>Falta configurar el proceso programado en Netlify.</div>}
        <div className={styles.actions}><button className="primary-button" disabled={Boolean(busy)} onClick={() => void act("save")}>{busy === "save" ? "Guardando…" : "Guardar agente"}</button><button className="secondary-button" disabled={Boolean(busy) || running} onClick={() => void act("run")}><Search size={16} />{running ? "Auditoría en proceso" : busy === "run" ? "Iniciando…" : "Auditar ahora"}</button></div>
        <small>Guarda los cambios del agente antes de auditar.</small>
        <div className={styles.webs}><strong>Webs de esta marca</strong>{(() => { let urls: string[] = []; try { urls = JSON.parse(brand.website_urls); } catch {} if (!urls.length && brand.website_url) urls = [brand.website_url]; return urls.length ? urls.map(url => <a key={url} href={url} target="_blank" rel="noreferrer">{url}</a>) : <p>Agrega las webs desde Gestionar marcas.</p>; })()}</div>
      </section>
      <section className={styles.card}><div className={styles.cardhead}><Link2 size={20} /><h2>Conexión con Google</h2></div><span className={styles.pill}>{data.google.connected ? "Cuenta conectada" : "Por conectar"}</span><p>Vincula cada marca con su propiedad de Search Console y su ficha de Google Business. La selección es independiente de las demás marcas.</p>
        <div className={styles.actions}><button className="secondary-button" disabled={Boolean(busy)} onClick={() => void connect()}>{data.google.connected ? "Reconectar Google" : "Conectar Google"}</button>{data.google.connected && <><button className="secondary-button" disabled={Boolean(busy)} onClick={() => void listResources()}>Cargar propiedades</button><button className={styles.textbutton} disabled={Boolean(busy)} onClick={() => void disconnect()}>Desconectar</button></>}</div>
        {!data.google.configured && <div className={styles.warning}>La conexión necesita configuración de Google Cloud. Consulta la guía incluida en el repositorio.</div>}
        <div className={styles.fields}><label htmlFor="seo-property">Propiedad de Search Console<select id="seo-property" disabled={Boolean(busy)} value={settings.search_property} onChange={e => setSettings({ ...settings, search_property: e.target.value })}><option value="">Sin vincular</option>{settings.search_property && !resources?.properties.some(p => p.siteUrl === settings.search_property) && <option value={settings.search_property}>{settings.search_property}</option>}{resources?.properties.map(p => <option key={p.siteUrl} value={p.siteUrl}>{p.siteUrl}</option>)}</select></label>
          <label htmlFor="seo-business">Perfil de Google Business<select id="seo-business" disabled={Boolean(busy)} value={settings.google_location} onChange={e => setSettings({ ...settings, google_location: e.target.value })}><option value="">Sin vincular</option>{settings.google_location && !resources?.locations.some(p => p.name === settings.google_location) && <option value={settings.google_location}>{settings.google_location}</option>}{resources?.locations.map(l => <option key={l.name} value={l.name}>{l.title}{l.websiteUri ? ` · ${l.websiteUri}` : ""}</option>)}</select></label></div>
        {resources?.errors.map((e, i) => <p className={styles.warning} key={i}>{e}</p>)}
        <small>Al desconectar se retira el acceso guardado para todas las marcas. El permiso business.manage es el que Google ofrece para consultar el perfil; esta versión solo lo lee.</small>
      </section></div>
      <section className={styles.card}><div className={styles.reporthead}><div className={styles.cardhead}><Clock3 size={20} /><h2>Auditorías e historial</h2></div>{data.runs.length > 0 && <select aria-label="Elegir auditoría" value={run?.id ?? ""} onChange={e => setHistoryId(e.target.value)}>{data.runs.map(r => <option key={r.id} value={r.id}>{date(r.started_at)} · {({ completed: "Completada", failed: "Con errores", queued: "En cola", running: "En proceso" } as Record<string, string>)[r.status] ?? r.status}</option>)}</select>}</div>
        {!run && <div className={styles.empty}><Globe size={32} /><h3>Tu punto de partida</h3><p>Ejecuta una auditoría para ver evidencia y acciones para {brand.name}.</p></div>}
        {run && <p>{date(run.started_at)} · {run.status === "completed" ? "Auditoría completada" : run.status === "failed" ? "Auditoría con errores" : "Procesando en segundo plano. Esta vista se actualiza automáticamente."}</p>}
        {run?.error && <p className={styles.warning}>{run.error}</p>}
        {report && <><p className={styles.scope}>{report.scope}</p>{report.pages.map((page, index) => <details className={styles.page} key={`${page.url}-${index}`} open={report.pages.length === 1}><summary><span>{page.title || page.url}</span><b>{page.error ? "Sin medir" : `${page.score}/100`}</b></summary><a href={page.url} target="_blank" rel="noreferrer">{page.url}</a>{page.error ? <p className={styles.warning}>{page.error}</p> : page.findings.length ? page.findings.map(f => <article className={styles.finding} key={f.code}><span className={`${styles.severity} ${styles[f.severity]}`}>{({ high: "Alta", medium: "Media", low: "Baja" })[f.severity]}</span><div><h3>{f.title}</h3><p>{f.evidence}</p><strong>Próxima acción</strong><p>{f.action}</p></div></article>) : <p>No se detectaron problemas en las comprobaciones de HTML realizadas.</p>}</details>)}
          <div className={styles.agentresult}><div className={styles.cardhead}><Sparkles size={19} /><h2>Plan del agente</h2></div><p>{report.agent.status}</p>{report.agent.text && <div className={styles.proposal}>{report.agent.text}</div>}</div>
          {report.google.errors.map((e, i) => <p className={styles.warning} key={i}>{e}</p>)}
          {report.google.search && <div className={styles.searchdata}><h2>Búsquedas reales · Search Console</h2><p>{report.google.period?.startDate} a {report.google.period?.endDate} · Hasta 30 consultas; no representa el total de tráfico.</p>{report.google.search.rows?.length ? <div className={styles.tablewrap}><table><thead><tr><th>Consulta</th><th>Clics</th><th>Impresiones</th><th>CTR</th><th>Posición media</th></tr></thead><tbody>{report.google.search.rows.map((row, i) => <tr key={i}><td>{row.keys.join(" · ")}</td><td>{row.clicks}</td><td>{row.impressions}</td><td>{(row.ctr * 100).toFixed(1)}%</td><td>{row.position.toFixed(1)}</td></tr>)}</tbody></table></div> : <p>Google no devolvió consultas para este periodo.</p>}</div>}
          {report.google.business && <div className={styles.business}><h2>Perfil de Google Business</h2><dl><dt>Nombre</dt><dd>{report.google.business.title || "Sin información"}</dd><dt>Categoría principal</dt><dd>{report.google.business.categories?.primaryCategory?.displayName || "Sin información"}</dd><dt>Web</dt><dd>{report.google.business.websiteUri || "Sin información"}</dd><dt>Teléfono</dt><dd>{report.google.business.phoneNumbers?.primaryPhone || "Sin información"}</dd><dt>Descripción</dt><dd>{report.google.business.profile?.description || "Sin descripción"}</dd><dt>Horario</dt><dd>{report.google.business.regularHours ? "Horario configurado" : "No se recibió un horario regular"}</dd></dl></div>}
        </>}
      </section>
    </>}
  </div>;
}
