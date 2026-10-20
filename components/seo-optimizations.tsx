"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { ArrowUpRight, CheckCircle2, GitPullRequest, RefreshCw, Sparkles } from "lucide-react";
import type { SeoDelivery, SeoProposal } from "@/lib/seo-optimizations";
import type { SeoGithubTarget } from "@/lib/seo-github";
import styles from "./seo-optimizations.module.css";

type Props = { brandId: string; websites: string[]; runId: string; completed: boolean };
type Data = { delivery: SeoDelivery; proposals: SeoProposal[] };
type Action =
  | { action: "destinations"; githubTargets: SeoGithubTarget[]; autoPr: boolean }
  | { action: "edit"; id: string; title: string; description: string }
  | { action: "apply" | "verify" | "dismiss" | "restore"; id: string };
type ActionResult = { saved?: boolean; queued?: boolean };
type Mutate = (action: Action) => Promise<ActionResult>;
type Feedback = { error: boolean; text: string } | null;

const POLL_MS = 6000;
const COMPLETION_RECHECKS = 5;
const activeStatuses = new Set(["draft", "queued", "processing", "pr_created", "failed"]);
const statuses: Record<string, { label: string; detail: string; tone: string }> = {
  draft: { label: "Borrador", detail: "Revisa los textos y guarda tus cambios antes de enviarlos.", tone: "neutral" },
  queued: { label: "En cola", detail: "La solicitud está pendiente de envío. El estado se actualiza automáticamente.", tone: "pending" },
  processing: { label: "En proceso", detail: "Se está enviando la propuesta. El estado se actualiza automáticamente.", tone: "pending" },
  pr_created: { label: "Propuesta en GitHub", detail: "Revisa y acepta el cambio en GitHub. Después de desplegar la web, verifica los textos aquí.", tone: "pending" },
  applied: { label: "Aceptada por Google", detail: "La API de Google aceptó el cambio. Esto no confirma que ya aparezca en la ficha pública.", tone: "success" },
  verified: { label: "Verificada en la web", detail: "En la última comprobación, la web pública mostraba el título y la descripción propuestos.", tone: "success" },
  failed: { label: "Envío con error", detail: "Revisa el error y el destino antes de reintentar. El envío pudo llegar al servicio; se conserva el mismo texto.", tone: "errorTone" },
  dismissed: { label: "Archivada en la app", detail: "Archivar no revierte cambios ni cierra una propuesta en GitHub.", tone: "neutral" },
};

function message(error: unknown) {
  return error instanceof Error ? error.message : "No se pudo completar la solicitud. Inténtalo de nuevo.";
}

async function read<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => null) as (T & { error?: string }) | null;
  if (!response.ok || !body) throw new Error(body?.error || "No se pudo completar la solicitud. Actualiza e inténtalo de nuevo.");
  return body;
}

function websiteKey(value: string) {
  try { const url = new URL(value); url.hash = ""; return url.href; } catch { return value; }
}

function publicLink(value: string) {
  try { const url = new URL(value); return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password ? url.href : undefined; } catch { return undefined; }
}

function date(value: number) {
  return new Date(value).toLocaleString("es-CO", { timeZone: "America/Bogota", dateStyle: "medium", timeStyle: "short" });
}

function Notice({ feedback }: { feedback: Feedback }) {
  if (!feedback) return null;
  return <p role={feedback.error ? "alert" : "status"} className={feedback.error ? styles.error : styles.notice}>{feedback.text}</p>;
}

export function SeoOptimizations({ brandId, websites, runId, completed }: Props) {
  const headingId = useId();
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [checkingRun, setCheckingRun] = useState(false);
  const [checkedAt, setCheckedAt] = useState(() => Date.now());
  const [queuedReceipt, setQueuedReceipt] = useState(false);
  const [destinationsDirty, setDestinationsDirty] = useState(false);
  const request = useRef<{ sequence: number; controller?: AbortController }>({ sequence: 0 });
  const mounted = useRef(false);

  useEffect(() => {
    const currentRequest = request.current;
    mounted.current = true;
    return () => { mounted.current = false; currentRequest.sequence++; currentRequest.controller?.abort(); };
  }, []);

  const refresh = useCallback(async () => {
    if (!brandId || !mounted.current) return;
    request.current.controller?.abort();
    const controller = new AbortController();
    const sequence = ++request.current.sequence;
    request.current.controller = controller;
    setRefreshing(true);
    try {
      const result = await read<Data>(await fetch(`/api/seo/optimizations?brandId=${encodeURIComponent(brandId)}`, { cache: "no-store", signal: controller.signal }));
      if (mounted.current && sequence === request.current.sequence) {
        setData(result);
        setCheckedAt(Date.now());
        setQueuedReceipt(false);
        setError("");
      }
    } catch (e) {
      if (mounted.current && !controller.signal.aborted && sequence === request.current.sequence) setError(message(e));
    } finally {
      if (mounted.current && sequence === request.current.sequence) setRefreshing(false);
    }
  }, [brandId]);

  // Proposals are saved just after the report. Keep this catch-up finite, even
  // when the completed audit has no suggestions, and allow partial batches.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let remaining = completed && runId ? COMPLETION_RECHECKS : 0;
    async function check() {
      await refresh();
      if (cancelled) return;
      setCheckingRun(remaining > 0);
      if (remaining > 0) {
        remaining--;
        timer = setTimeout(() => void check(), POLL_MS);
      }
    }
    void check();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [refresh, runId, completed]);

  const inFlight = data?.proposals.some(p => p.status === "queued" || p.status === "processing") ?? false;
  useEffect(() => {
    if ((!inFlight && !queuedReceipt) || checkingRun) return;
    let cancelled = false;
    let timer = setTimeout(() => void poll(), POLL_MS);
    async function poll() {
      await refresh();
      if (!cancelled) timer = setTimeout(() => void poll(), POLL_MS);
    }
    return () => { cancelled = true; clearTimeout(timer); };
  }, [inFlight, queuedReceipt, checkingRun, refresh]);

  const mutate: Mutate = async action => {
    const result = await read<ActionResult>(await fetch("/api/seo/optimizations", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...action, brandId }),
    }));
    if (!mounted.current) return result;
    // Invalidate a GET started before this write so it cannot roll the UI back.
    request.current.sequence++;
    request.current.controller?.abort();
    if (result.queued) setQueuedReceipt(true);
    const updatedAt = Date.now();
    setData(current => {
      if (!current) return current;
      if (action.action === "destinations") return { ...current, delivery: { ...current.delivery, githubTargets: action.githubTargets, autoPr: action.autoPr } };
      return { ...current, proposals: current.proposals.map(p => {
        if (p.id !== action.id) return p;
        if (action.action === "edit") return { ...p, title: p.kind === "github" ? action.title.trim() : p.title, description: action.description.trim() };
        if (action.action === "restore") return p; // Restoration creates a separate proposal.
        return { ...p, status: action.action === "apply" ? "queued" : action.action === "verify" ? (p.kind === "google" ? "applied" : "verified") : "dismissed", error: "", updated_at: updatedAt };
      }) };
    });
    await refresh();
    return result;
  };

  if (!brandId) return null;
  const proposals = data?.proposals ?? [];
  const newestRunId = proposals[0]?.run_id;
  const visible = (p: SeoProposal) => p.status !== "dismissed" && (activeStatuses.has(p.status) || p.run_id === newestRunId || p.run_id === runId);
  const current = proposals.filter(visible);
  const history = proposals.filter(p => !visible(p));
  const card = (proposal: SeoProposal) => <ProposalCard
    key={proposal.id} proposal={proposal} delivery={data!.delivery} mutate={mutate}
    destinationsDirty={destinationsDirty} checkedAt={checkedAt}
    blockedByOther={proposals.some(p => p.id !== proposal.id && p.kind === proposal.kind && p.target === proposal.target && ["queued", "processing", "pr_created"].includes(p.status))}
  />;

  return <section className={styles.panel} aria-labelledby={headingId}>
    <header className={styles.heading}>
      <div><div className={styles.headingTitle}><Sparkles size={20} aria-hidden="true" /><h2 id={headingId}>Mejoras de esta marca</h2></div><p>Revisa cada propuesta, elige su destino y sigue el resultado.</p></div>
      <button type="button" className="secondary-button" disabled={refreshing} onClick={() => void refresh()}><RefreshCw size={15} aria-hidden="true" />{refreshing ? "Actualizando…" : "Actualizar mejoras"}</button>
    </header>
    {error && <Notice feedback={{ error: true, text: error }} />}
    {!data && !error && <p role="status" className={styles.muted}>Cargando las mejoras…</p>}
    {data && <>
      <Destinations websites={websites} delivery={data.delivery} inFlight={inFlight || queuedReceipt} mutate={mutate} onDirty={setDestinationsDirty} />
      <div className={styles.list}>
        {current.map(card)}
        {!current.length && <div className={styles.empty}><CheckCircle2 size={25} aria-hidden="true" /><h3>{checkingRun ? "Buscando propuestas de la auditoría…" : "Sin mejoras pendientes"}</h3><p>{checkingRun ? "Las propuestas pueden tardar unos segundos más que el informe." : "Las nuevas propuestas aparecerán aquí después de una auditoría con sugerencias disponibles."}</p></div>}
      </div>
      {history.length > 0 && <details className={styles.history}><summary>Historial de mejoras ({history.length})</summary><p className={styles.muted}>Propuestas anteriores y archivadas. Archivar en la app no cierra una propuesta en GitHub.</p><div className={styles.list}>{history.map(card)}</div></details>}
      {proposals.length >= 60 && <p className={styles.muted}>Se muestran las 60 propuestas más recientes de esta marca.</p>}
    </>}
  </section>;
}

function Destinations({ websites, delivery, inFlight, mutate, onDirty }: {
  websites: string[]; delivery: SeoDelivery; inFlight: boolean; mutate: Mutate; onDirty: (dirty: boolean) => void;
}) {
  const id = useId();
  const urls = [...new Set(websites.filter(Boolean).map(websiteKey))];
  const [fields, setFields] = useState<Record<string, SeoGithubTarget>>(() => Object.fromEntries(delivery.githubTargets.map(t => [websiteKey(t.url), t])));
  const [autoPr, setAutoPr] = useState(delivery.autoPr);
  const [dirty, setDirty] = useState(false);
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const defaults = (url: string): SeoGithubTarget => ({ url, repository: "", branch: "main", path: "index.html" });
  const targets = urls.map(url => fields[url] ?? defaults(url));
  const hasRepository = targets.some(t => t.repository.trim());
  function markDirty() { setDirty(true); onDirty(true); setFeedback(null); }
  function change(url: string, field: "repository" | "branch" | "path", value: string) {
    setFields(current => ({ ...current, [url]: { ...(current[url] ?? defaults(url)), [field]: value } }));
    markDirty();
  }
  async function save() {
    if (pending || inFlight) return;
    setPending(true); setFeedback(null);
    // Empty repository fields mean no destination. Never persist the defaults
    // as an inferred connection, even if a branch/path has been entered.
    const githubTargets = targets.filter(t => t.repository.trim()).map(t => ({ ...t, repository: t.repository.trim().toLowerCase(), branch: t.branch.trim(), path: t.path.trim() }));
    try {
      await mutate({ action: "destinations", githubTargets, autoPr });
      setFields(Object.fromEntries(githubTargets.map(t => [t.url, t])));
      setDirty(false); onDirty(false);
      setFeedback({ error: false, text: autoPr ? "Destinos guardados. Las próximas auditorías crearán propuestas en GitHub para estas webs; tendrás que revisarlas y aceptarlas allí." : "Destinos guardados. Cada propuesta se enviará cuando tú lo indiques." });
    } catch (e) { setFeedback({ error: true, text: message(e) }); }
    finally { setPending(false); }
  }
  return <details className={styles.destinations}>
    <summary>Destinos de las mejoras <span className={styles.summaryHint}>{dirty ? "Cambios sin guardar" : `${delivery.githubTargets.length} webs con destino`}</span></summary>
    <div className={styles.destinationBody}>
      <p>Asocia cada web con el archivo que define su título y descripción. Puede ser HTML o un archivo de Next con metadatos estáticos. Revisa la rama y el archivo antes de guardar.</p>
      <div className={delivery.githubConfigured ? styles.connection : styles.warning}>
        {delivery.githubConfigured ? <><GitPullRequest size={16} aria-hidden="true" /><span>GitHub configurado. El acceso a cada repositorio se comprueba al enviar.</span></> : <><strong>GitHub no está conectado.</strong> Configura <code>SEO_GITHUB_TOKEN</code> en Netlify con acceso a los repositorios de estas webs. Después, pulsa «Actualizar mejoras».</>}
      </div>
      <form onSubmit={e => { e.preventDefault(); void save(); }}>
        <fieldset className={styles.destinationFields} disabled={pending || inFlight}>
          {!urls.length && <p className={styles.muted}>Agrega una web en «Gestionar marcas» para configurar su destino.</p>}
          {targets.map((target, index) => <div className={styles.destinationRow} key={target.url}>
            <strong className={styles.url}>{target.url}</strong>
            <div className={styles.targetInputs}>
              <label htmlFor={`${id}-repo-${index}`}>Repositorio (propietario/nombre)<input id={`${id}-repo-${index}`} value={target.repository} onChange={e => change(target.url, "repository", e.target.value)} placeholder="organizacion/sitio-web" maxLength={140} autoCapitalize="none" autoCorrect="off" spellCheck={false} /></label>
              <label htmlFor={`${id}-branch-${index}`}>Rama<input id={`${id}-branch-${index}`} value={target.branch} onChange={e => change(target.url, "branch", e.target.value)} required={Boolean(target.repository.trim())} maxLength={200} autoCapitalize="none" autoCorrect="off" spellCheck={false} /></label>
              <label htmlFor={`${id}-path-${index}`}>Archivo de la página<input id={`${id}-path-${index}`} value={target.path} onChange={e => change(target.url, "path", e.target.value)} required={Boolean(target.repository.trim())} maxLength={512} autoCapitalize="none" autoCorrect="off" spellCheck={false} aria-describedby={`${id}-path-hint-${index}`} /><small id={`${id}-path-hint-${index}`}>Por ejemplo: index.html o app/layout.tsx. En Next también se admite app/page.tsx, con o sin src/, con exportación de metadatos estáticos.</small></label>
            </div>
          </div>)}
          <p className={styles.muted}>Deja el repositorio vacío para no asociar esa web. Vaciar uno guardado elimina su destino al guardar; las propuestas existentes en GitHub siguen abiertas.</p>
          <label className={styles.toggle}><input type="checkbox" checked={autoPr} disabled={!autoPr && (!delivery.githubConfigured || !hasRepository)} onChange={e => { setAutoPr(e.target.checked); markDirty(); }} /><span>Crear propuestas en GitHub automáticamente tras las próximas auditorías<small>Crea una rama y una solicitud de cambios en los repositorios guardados. No acepta los cambios ni publica la web. Google siempre requiere una acción manual.</small></span></label>
        </fieldset>
        {inFlight && <p className={styles.warning}>Espera a que termine el envío en curso para guardar destinos.</p>}
        <div className={styles.actions}><button type="submit" className="primary-button" disabled={pending || inFlight || !dirty || (autoPr && (!delivery.githubConfigured || !hasRepository))}>{pending ? "Guardando destinos…" : "Guardar destinos"}</button>{dirty && <span className={styles.muted}>Cambios sin guardar</span>}</div>
      </form>
      <p className={styles.manual}>¿Tu web está en Shopify y no tiene una conexión de publicación? Copia el título y la descripción de la propuesta en su editor SEO. Configurar un repositorio aquí no conecta Shopify.</p>
      <Notice feedback={feedback} />
    </div>
  </details>;
}

function beforeMetadata(proposal: SeoProposal): { title: string; description: string } | null {
  if (proposal.kind === "google") return { title: "", description: proposal.before_value };
  try {
    const value = JSON.parse(proposal.before_value) as { title?: unknown; description?: unknown } | null;
    if (!value || typeof value.title !== "string" || typeof value.description !== "string") return null;
    return { title: value.title, description: value.description };
  } catch { return null; }
}

function ProposalCard({ proposal, delivery, mutate, destinationsDirty, blockedByOther, checkedAt }: {
  proposal: SeoProposal; delivery: SeoDelivery; mutate: Mutate; destinationsDirty: boolean; blockedByOther: boolean; checkedAt: number;
}) {
  const id = useId();
  // This component is keyed by proposal ID. Refreshes never replace local edits.
  const [title, setTitle] = useState(proposal.title);
  const [description, setDescription] = useState(proposal.description);
  const [pending, setPending] = useState("");
  const [feedback, setFeedback] = useState<Feedback>(null);
  const lock = useRef(false);
  const draft = proposal.status === "draft";
  const google = proposal.kind === "google";
  const dirty = draft && (title !== proposal.title || description !== proposal.description);
  const before = beforeMetadata(proposal);
  const status = statuses[proposal.status] ?? { label: "Estado pendiente de revisar", detail: "Actualiza para consultar el estado de esta propuesta.", tone: "neutral" };
  const target = delivery.githubTargets.find(t => websiteKey(t.url) === websiteKey(proposal.target));
  const expired = checkedAt - proposal.created_at > 7 * 86400_000;
  const canSend = draft || proposal.status === "failed";
  const canArchive = ["draft", "failed", "pr_created"].includes(proposal.status);
  const canVerify = (google ? ["failed", "applied"] : ["pr_created", "verified"]).includes(proposal.status);
  const canRestore = google && proposal.status === "applied";
  const sendBlock = dirty ? "Guarda los textos editados antes de enviar la propuesta."
    : expired ? "Esta propuesta tiene más de siete días. Ejecuta una nueva auditoría antes de enviarla."
      : blockedByOther ? "Ya hay otra propuesta en curso para este destino. Revisa su estado antes de enviar otra."
        : !google && destinationsDirty ? "Guarda los destinos antes de crear la propuesta en GitHub."
          : !google && !delivery.githubConfigured ? "GitHub no está conectado. Configura SEO_GITHUB_TOKEN en Netlify y pulsa «Actualizar mejoras»."
            : !google && !target ? "Asocia esta web con un repositorio en «Destinos de las mejoras», o copia los textos para aplicarlos manualmente."
              : "";
  const resultUrl = publicLink(proposal.result_url);
  const targetUrl = !google ? publicLink(proposal.target) : undefined;
  const shownTitle = draft ? title : proposal.title;
  const shownDescription = draft ? description : proposal.description;

  async function act(action: "edit" | "apply" | "verify" | "dismiss" | "restore") {
    if (lock.current) return;
    lock.current = true; setPending(action); setFeedback(null);
    try {
      await mutate(action === "edit" ? { action, id: proposal.id, title, description } : { action, id: proposal.id });
      if (action === "edit") { setTitle(google ? proposal.title : title.trim()); setDescription(description.trim()); }
      const notices = {
        edit: "Textos guardados. La propuesta está lista para enviar.",
        apply: google ? "Solicitud en cola para cambiar la descripción de tu ficha pública de Google." : "Solicitud en cola para crear la propuesta en GitHub.",
        verify: google ? "Comprobación completada: la API de Google devuelve la descripción propuesta. No se ha escrito ningún cambio ni se ha confirmado su visibilidad en la ficha pública." : "Verificación completada: la web pública muestra estos textos.",
        dismiss: "Archivada en la app. Si tenía una propuesta en GitHub, sigue abierta allí.",
        restore: "Restauración en cola. Verás una nueva propuesta con la descripción anterior; se enviará a tu ficha pública de Google.",
      };
      setFeedback({ error: false, text: notices[action] });
    } catch (e) { setFeedback({ error: true, text: message(e) }); }
    finally { lock.current = false; setPending(""); }
  }
  async function copy(field: "title" | "description") {
    if (lock.current) return;
    lock.current = true; setPending(`copy-${field}`); setFeedback(null);
    try {
      if (!navigator.clipboard?.writeText) throw new Error("El navegador no permite copiar. Selecciona el texto y cópialo manualmente.");
      await navigator.clipboard.writeText(field === "title" ? shownTitle : shownDescription);
      setFeedback({ error: false, text: `${field === "title" ? "Título copiado" : "Descripción copiada"}${dirty ? " con tus cambios sin guardar" : ""}.` });
    } catch { setFeedback({ error: true, text: "No se pudo copiar al portapapeles. Selecciona el texto y cópialo manualmente." }); }
    finally { lock.current = false; setPending(""); }
  }

  return <article className={styles.proposal} aria-labelledby={`${id}-heading`} aria-busy={Boolean(pending)}>
    <header className={styles.proposalHeading}>
      <div><span className={styles.eyebrow}>{google ? "GOOGLE BUSINESS" : "WEB · GITHUB"}</span><h3 id={`${id}-heading`}>{google ? proposal.title : "Título y descripción de la web"}</h3>{targetUrl ? <a href={targetUrl} target="_blank" rel="noopener noreferrer">{proposal.target}<ArrowUpRight size={13} aria-hidden="true" /></a> : <span className={styles.url}>{proposal.target}</span>}</div>
      <span className={`${styles.badge} ${styles[status.tone]}`}>{status.label}</span>
    </header>
    <p className={styles.muted}>Creada el {date(proposal.created_at)} · Última actualización: {date(proposal.updated_at)}</p>
    <p className={styles.statusDetail}>{status.detail}</p>
    <div className={styles.comparison}>
      <div className={styles.before}><h4>Antes de la propuesta</h4><p className={styles.caption}>Texto registrado al preparar la mejora.</p>{before ? <dl>{!google && <><dt>Título</dt><dd>{before.title || "Sin título registrado"}</dd></>}<dt>Descripción</dt><dd>{before.description || "Sin descripción registrada"}</dd></dl> : <p className={styles.muted}>El texto anterior no está disponible.</p>}</div>
      <div className={styles.proposed}><h4>Texto propuesto</h4>{draft ? <div className={styles.editor}>
        {!google && <label htmlFor={`${id}-title`}>Título<input id={`${id}-title`} value={title} onChange={e => { setTitle(e.target.value); setFeedback(null); }} maxLength={150} disabled={Boolean(pending)} /><small>{title.length}/150 caracteres</small></label>}
        <label htmlFor={`${id}-description`}>Descripción<textarea id={`${id}-description`} value={description} onChange={e => { setDescription(e.target.value); setFeedback(null); }} maxLength={google ? 750 : 320} rows={google ? 7 : 4} disabled={Boolean(pending)} /><small>{description.length}/{google ? 750 : 320} caracteres{google ? " · Sin enlaces" : ""}</small></label>
      </div> : <dl>{!google && <><dt>Título</dt><dd>{proposal.title}</dd></>}<dt>Descripción</dt><dd>{proposal.description || "Sin descripción"}</dd></dl>}
        <div className={styles.copyActions}>{!google && <button type="button" disabled={Boolean(pending)} onClick={() => void copy("title")}>{pending === "copy-title" ? "Copiando…" : "Copiar título"}</button>}<button type="button" disabled={Boolean(pending)} onClick={() => void copy("description")}>{pending === "copy-description" ? "Copiando…" : "Copiar descripción"}</button></div>
      </div>
    </div>
    {proposal.error && <Notice feedback={{ error: true, text: proposal.error }} />}
    {canSend && sendBlock && <p id={`${id}-send-block`} className={styles.warning}>{sendBlock}</p>}
    {canSend && google && <p id={`${id}-public-write`} className={styles.warning}><strong>Cambio en tu ficha pública.</strong> Al aplicar, se envía esta descripción a Google Business. Google puede tardar en mostrarla.</p>}
    {canSend && !google && <p className={styles.muted}>Se creará una rama y una solicitud de cambios en GitHub. Revisa, acepta y despliega el cambio allí para publicarlo.</p>}
    {canVerify && google && <p id={`${id}-verify-note`} className={styles.muted}>Comprobar en Google solo consulta la descripción actual, sin modificarla. Puedes hacerlo aunque hayan pasado siete días; si coincide, podrás restaurar la descripción anterior. La comprobación no confirma su visibilidad pública.</p>}
    {canRestore && <div className={styles.restoreInfo}><p id={`${id}-restore-note`}>Restaurar envía la descripción anterior a tu ficha pública de Google como una nueva propuesta. También es un cambio público.</p><details><summary>Ver descripción que se restaurará</summary><p className={styles.savedText}>{proposal.before_value || "Sin descripción: la restauración dejará la descripción vacía."}</p></details></div>}
    {canArchive && <p id={`${id}-archive-note`} className={styles.muted}>Archivar solo mueve esta mejora al historial de la app.{proposal.status === "pr_created" ? " La propuesta en GitHub seguirá abierta; no se cierra ni se revierte ningún cambio." : " No revierte cambios externos."}{dirty ? " Las ediciones sin guardar se perderán." : ""}</p>}
    <div className={styles.actions}>
      {draft && <button type="button" className="secondary-button" disabled={Boolean(pending) || !dirty || (!google && !title.trim()) || !description.trim()} onClick={() => void act("edit")}>{pending === "edit" ? "Guardando textos…" : "Guardar textos"}</button>}
      {canSend && <button type="button" className="primary-button" disabled={Boolean(pending) || Boolean(sendBlock)} aria-describedby={[sendBlock ? `${id}-send-block` : "", google ? `${id}-public-write` : ""].filter(Boolean).join(" ") || undefined} onClick={() => void act("apply")}>{pending === "apply" ? "Enviando…" : google ? "Aplicar descripción en Google" : "Crear propuesta en GitHub"}</button>}
      {canVerify && <button type="button" className="secondary-button" disabled={Boolean(pending)} aria-describedby={google ? `${id}-verify-note` : undefined} onClick={() => void act("verify")}>{pending === "verify" ? (google ? "Comprobando en Google…" : "Verificando…") : google ? "Comprobar en Google" : "Verificar en la web"}</button>}
      {canRestore && <button type="button" className="secondary-button" disabled={Boolean(pending) || blockedByOther} aria-describedby={`${id}-restore-note`} onClick={() => void act("restore")}>{pending === "restore" ? "Solicitando restauración…" : "Restaurar descripción anterior en Google"}</button>}
      {resultUrl && <a className={styles.resultLink} href={resultUrl} target="_blank" rel="noopener noreferrer">{google ? "Ver resultado" : "Ver propuesta en GitHub"}<ArrowUpRight size={14} aria-hidden="true" /></a>}
      {canArchive && <button type="button" className={styles.archiveButton} disabled={Boolean(pending)} aria-describedby={`${id}-archive-note`} onClick={() => void act("dismiss")}>{pending === "dismiss" ? "Archivando…" : "Archivar en la app"}</button>}
      {dirty && <span className={styles.muted}>Textos sin guardar</span>}
    </div>
    {canRestore && blockedByOther && <p className={styles.muted}>Espera a que termine el otro envío a esta ficha antes de restaurar.</p>}
    <Notice feedback={feedback} />
  </article>;
}

export default SeoOptimizations;
