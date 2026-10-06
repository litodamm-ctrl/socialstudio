"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  addDays,
  addWeeks,
  format,
  isSameDay,
  startOfWeek,
  subWeeks,
} from "date-fns";
import { es } from "date-fns/locale";
import Image from "next/image";
import {
  Camera,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  CirclePlus,
  Clock3,
  ImagePlus,
  FileText,
  Globe,
  HardDrive,
  Layers3,
  LayoutGrid,
  Link2,
  Menu,
  MoreHorizontal,
  MessageSquareText,
  Plus,
  RefreshCw,
  Send,
  Settings2,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";

type Post = {
  id: string;
  brand: string;
  caption: string;
  mediaType: string;
  mediaUrl: string;
  scheduledAt: string | null;
  status: "draft" | "scheduled" | "publishing" | "published" | "failed";
  publicationError?: string | null;
  facebookStatus?: string | null;
  facebookError?: string | null;
};

type AgentDraft = {
  brand: string;
  headline: string;
  caption: string;
  visualConcept: string;
  imagePrompt: string;
  mediaUrl: string;
};

async function prepareMediaFile(file: File) {
  if (file.type !== "image/png") return file;
  const bitmap = await createImageBitmap(file);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("No pudimos preparar la imagen. Intenta con un archivo JPG.");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(bitmap, 0, 0);
  bitmap.close();
  const jpeg = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.92));
  if (!jpeg) throw new Error("No pudimos preparar la imagen. Intenta con un archivo JPG.");
  return new File([jpeg], file.name.replace(/\.png$/i, ".jpg"), { type: "image/jpeg" });
}

const defaultBrands = [
  { name: "FITZONE", color: "#c44a6b", handle: "@fitzone_ctg", initials: "FZ" },
  { name: "Bahía Pádel", color: "#217d75", handle: "@bahiapadel", initials: "BP" },
  { name: "D’Neyla", color: "#bd7855", handle: "@dneylacentrohistorico", initials: "D" },
  { name: "Manglar", color: "#68865a", handle: "@manglarartesanias", initials: "M" },
];

type Brand = {
  id: string;
  name: string;
  color: string;
  handle: string;
  initials: string;
  active: boolean;
  essence: string;
  websiteUrl: string;
  websiteUrls: string[];
  driveFolderUrl: string;
  driveConnected: boolean;
  autoSchedule: boolean;
  autoCrosspost: boolean;
  postingDays: number[];
  preferredTime: string;
  storyTime: string;
  autoStories: boolean;
  automationStatus: { cycleStart: string; cycleEnd: string; planned: number; total: number; failed: number; lastError: string | null } | null;
};

type BrandAsset = { id: string; name: string; contentType: string; size: number };

const navItems = [
  { label: "Calendario", icon: CalendarDays, active: true },
  { label: "Publicaciones", icon: Layers3 },
  { label: "Biblioteca", icon: LayoutGrid },
];

function brandFor(name: string, availableBrands: Array<{ name: string; color: string; initials: string; handle: string }>) {
  return availableBrands.find((brand) => brand.name === name) ?? availableBrands[0] ?? { name, color: "#557b66", initials: "?", handle: "" };
}

function localDateValue(date: Date) {
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function statusLabel(status: Post["status"]) {
  if (status === "published") return "Publicado";
  if (status === "publishing") return "Publicando";
  if (status === "failed") return "Revisar publicación";
  if (status === "scheduled") return "En agenda";
  return "Borrador";
}

export default function Home() {
  const [brands, setBrands] = useState<Brand[]>(defaultBrands.map((item, index) => ({ id: `seed-${index}`, ...item, active: true, essence: "", websiteUrl: "", websiteUrls: [], driveFolderUrl: "", driveConnected: false, autoSchedule: false, autoCrosspost: false, postingDays: [0, 1, 2, 3, 4, 5, 6], preferredTime: "18:00", storyTime: "09:00", autoStories: true, automationStatus: null })));
  const [archivedBrands, setArchivedBrands] = useState<Brand[]>([]);
  const [week, setWeek] = useState(() => startOfWeek(new Date(), { weekStartsOn: 1 }));
  const [posts, setPosts] = useState<Post[]>([]);
  const [connectedAccounts, setConnectedAccounts] = useState<Record<string, string>>({});
  const [connectedFacebookPages, setConnectedFacebookPages] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editingPostId, setEditingPostId] = useState<string | null>(null);
  const [brand, setBrand] = useState(defaultBrands[0].name);
  const [caption, setCaption] = useState("");
  const [mediaType, setMediaType] = useState("Imagen");
  const [selectedMediaFile, setSelectedMediaFile] = useState<File | null>(null);
  const [mediaPreview, setMediaPreview] = useState("");
  const [uploadedMediaUrl, setUploadedMediaUrl] = useState("");
  const [uploadingMedia, setUploadingMedia] = useState(false);
  const mediaInput = useRef<HTMLInputElement>(null);
  const brandAssetInput = useRef<HTMLInputElement>(null);
  const [scheduledAt, setScheduledAt] = useState(() => {
    const later = new Date();
    later.setDate(later.getDate() + 1);
    later.setHours(18, 0, 0, 0);
    return localDateValue(later);
  });
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState("");
  const [mobileMenu, setMobileMenu] = useState(false);
  const [agentOpen, setAgentOpen] = useState(false);
  const [agentObjective, setAgentObjective] = useState("Ventas");
  const [agentBrief, setAgentBrief] = useState("");
  const [agentCallToAction, setAgentCallToAction] = useState("");
  const [agentGenerating, setAgentGenerating] = useState(false);
  const [agentConfigured, setAgentConfigured] = useState<boolean | null>(null);
  const [agentMissing, setAgentMissing] = useState<string[]>([]);
  const [agentError, setAgentError] = useState("");
  const [agentDraft, setAgentDraft] = useState<AgentDraft | null>(null);
  const [agentPreviewUrl, setAgentPreviewUrl] = useState("");
  const [brandManagerOpen, setBrandManagerOpen] = useState(false);
  const [brandNameInput, setBrandNameInput] = useState("");
  const [brandHandleInput, setBrandHandleInput] = useState("");
  const [brandBusy, setBrandBusy] = useState(false);
  const [editingBrandId, setEditingBrandId] = useState("");
  const [brandEssence, setBrandEssence] = useState("");
  const [brandWebsites, setBrandWebsites] = useState<string[]>([""]);
  const [brandDrive, setBrandDrive] = useState("");
  const [brandAutoSchedule, setBrandAutoSchedule] = useState(false);
  const [brandAutoCrosspost, setBrandAutoCrosspost] = useState(false);
  const [brandPostingDays, setBrandPostingDays] = useState<number[]>([0, 1, 2, 3, 4, 5, 6]);
  const [brandPreferredTime, setBrandPreferredTime] = useState("18:00");
  const [brandStoryTime, setBrandStoryTime] = useState("09:00");
  const [brandAutoStories, setBrandAutoStories] = useState(true);
  const [brandAssets, setBrandAssets] = useState<BrandAsset[]>([]);

  const reloadBrands = useCallback(async () => {
    const response = await fetch("/api/brands", { cache: "no-store" });
    if (!response.ok) return [] as Brand[];
    const data = await response.json() as { brands?: Brand[]; archivedBrands?: Brand[] };
    const active = Array.isArray(data.brands) ? data.brands : [];
    setBrands(active);
    setArchivedBrands(Array.isArray(data.archivedBrands) ? data.archivedBrands : []);
    setBrand((current) => active.some((item) => item.name === current) ? current : (active[0]?.name ?? ""));
    return active;
  }, []);

  const reloadPosts = useCallback(async () => {
    setLoading(true);
    try {
      const [response, accountResponse, facebookResponse, agentStatus] = await Promise.all([
        fetch("/api/posts", { cache: "no-store" }),
        fetch("/api/meta/accounts", { cache: "no-store" }).catch(() => Response.error()),
        fetch("/api/meta/facebook/accounts", { cache: "no-store" }).catch(() => Response.error()),
        fetch("/api/agent/status", { cache: "no-store" }).catch(() => Response.error()),
        reloadBrands(),
      ]);
      if (!response.ok) throw new Error("No se pudo cargar el calendario");
      const data = await response.json() as { posts?: Post[] };
      setPosts(Array.isArray(data.posts) ? data.posts : []);
      if (accountResponse.ok) {
        const accountData = await accountResponse.json() as { accounts?: Array<{ brand: string; username: string }> };
        const next: Record<string, string> = {};
        for (const account of accountData.accounts ?? []) next[account.brand] = account.username;
        setConnectedAccounts(next);
      }
      if (facebookResponse.ok) {
        const facebookData = await facebookResponse.json() as { accounts?: Array<{ brand: string; pageName: string }> };
        const pages: Record<string, string> = {};
        for (const account of facebookData.accounts ?? []) pages[account.brand] = account.pageName;
        setConnectedFacebookPages(pages);
      }
      if (agentStatus.ok) {
        const status = await agentStatus.json() as { configured?: boolean; missing?: string[] };
        setAgentConfigured(Boolean(status.configured));
        setAgentMissing(status.missing ?? []);
      }
      setLoadError("");
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "No se pudo cargar el calendario");
    } finally {
      setLoading(false);
    }
  }, [reloadBrands]);

  useEffect(() => {
    const task = window.setTimeout(() => void reloadPosts(), 0);
    return () => window.clearTimeout(task);
  }, [reloadPosts]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const result = params.get("drive");
    const messages: Record<string, string> = {
      connected: "Google Drive quedó conectado a la marca. El agente ya puede leer los archivos de la carpeta.",
      config_missing: "Configura GOOGLE_CLIENT_ID y GOOGLE_CLIENT_SECRET como secretos del sitio para conectar Drive.",
      connect_failed: "No se pudo conectar Google Drive. Revisa la configuración OAuth de Google y vuelve a intentarlo.",
      invalid_state: "El enlace para Google Drive expiró. Intenta conectar de nuevo.",
      cancelled: "Cancelaste la conexión con Google Drive.",
    };
    if (!result || !messages[result]) return;
    window.history.replaceState({}, "", window.location.pathname);
    const showToast = window.setTimeout(() => setToast(messages[result]), 0);
    const refresh = result === "connected" ? window.setTimeout(() => void reloadBrands(), 0) : undefined;
    return () => { window.clearTimeout(showToast); if (refresh !== undefined) window.clearTimeout(refresh); };
  }, [reloadBrands]);

  useEffect(() => () => {
    if (mediaPreview.startsWith("blob:")) URL.revokeObjectURL(mediaPreview);
  }, [mediaPreview]);

  useEffect(() => () => {
    if (agentPreviewUrl.startsWith("blob:")) URL.revokeObjectURL(agentPreviewUrl);
  }, [agentPreviewUrl]);

  useEffect(() => {
    const result = new URLSearchParams(window.location.search).get("meta");
    const messages: Record<string, string> = {
      connected: "Cuenta de Instagram conectada.",
      facebook_connected: "Página de Facebook vinculada. Las próximas publicaciones de esta marca también se enviarán a Facebook.",
      facebook_config_missing: "Agrega Facebook Login a la app de Meta y registra /api/meta/facebook/callback como URI de redirección.",
      facebook_page_not_linked: "No encontramos una Página de Facebook vinculada a esta cuenta de Instagram. Vincúlala en Meta Business Suite y vuelve a conectar.",
      facebook_instagram_missing: "Conecta primero Instagram para asociar la Página de Facebook correcta.",
      facebook_cancelled: "Cancelaste la autorización de Facebook.",
      facebook_invalid_state: "El enlace de Facebook expiró. Intenta conectar la Página de nuevo.",
      facebook_connect_failed: "No pudimos vincular la Página de Facebook. Verifica permisos y vuelve a intentarlo.",
      missing_app_config: "Falta configurar la app de Meta y la clave para cifrar tokens antes de conectar cuentas.",
      cancelled: "Cancelaste la autorización de Instagram.",
      invalid_state: "El enlace de autorización expiró o ya se usó. Intenta de nuevo.",
      connection_failed: "No pudimos completar la conexión de Instagram. Revisa la configuración de Meta y vuelve a intentar.",
      setup_error: "No se pudo iniciar la autorización. Revisa la configuración e intenta de nuevo.",
      storage_unavailable: "El almacenamiento no respondió durante la autorización. Intenta más tarde.",
      missing_code: "Instagram no devolvió el código necesario para completar la autorización.",
    };
    if (result && messages[result]) {
      window.history.replaceState({}, "", window.location.pathname);
      const showToast = window.setTimeout(() => setToast(messages[result]), 0);
      const hideToast = window.setTimeout(() => setToast(""), 6500);
      const refreshPosts = ["connected", "facebook_connected"].includes(result) ? window.setTimeout(() => void reloadPosts(), 0) : undefined;
      return () => {
        window.clearTimeout(showToast);
        window.clearTimeout(hideToast);
        if (refreshPosts !== undefined) window.clearTimeout(refreshPosts);
      };
    }
  }, [reloadPosts]);

  useEffect(() => {
    const context = (document as Document & {
      modelContext?: {
        registerTool?: (tool: {
          name: string;
          title: string;
          description: string;
          inputSchema: Record<string, unknown>;
          annotations: { readOnlyHint: boolean; untrustedContentHint: boolean };
          execute: (input: unknown) => Promise<unknown>;
        }, options?: { signal?: AbortSignal }) => void | Promise<void>;
      };
    }).modelContext;
    if (!context?.registerTool) return;
    const lifecycle = new AbortController();
    void Promise.resolve(context.registerTool({
      name: "save_instagram_post_to_calendar",
      title: "Guardar publicación en el calendario",
      description: "Guarda un borrador o una pieza futura en el calendario de Instagram del espacio de trabajo. Esto no publica contenido en Instagram.",
      inputSchema: {
        type: "object",
        properties: {
          brand: { type: "string", enum: brands.map((item) => item.name) },
          caption: { type: "string", minLength: 1, maxLength: 2200 },
          mediaType: { type: "string", enum: ["Imagen", "Reel", "Historia"] },
          scheduledAt: { type: "string", description: "Fecha futura ISO 8601; omítela para crear un borrador." },
        },
        required: ["brand", "caption", "mediaType"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, untrustedContentHint: true },
      async execute(input) {
        if (!input || typeof input !== "object") throw new Error("Los datos de la publicación no son válidos.");
        const values = input as Record<string, unknown>;
        if (typeof values.brand !== "string" || !brands.some((item) => item.name === values.brand)) throw new Error("Elige una marca disponible.");
        if (typeof values.caption !== "string" || !values.caption.trim() || values.caption.length > 2200) throw new Error("Escribe un texto de hasta 2.200 caracteres.");
        if (typeof values.mediaType !== "string" || !["Imagen", "Reel", "Historia"].includes(values.mediaType)) throw new Error("Elige un formato disponible.");
        const status = typeof values.scheduledAt === "string" ? "scheduled" : "draft";
        if (status === "scheduled" && (!Number.isFinite(Date.parse(values.scheduledAt as string)) || Date.parse(values.scheduledAt as string) <= Date.now())) throw new Error("La fecha debe ser futura.");
        const response = await fetch("/api/posts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...values, status }),
        });
        const result = await response.json() as { error?: string; post: Post };
        if (!response.ok) throw new Error(result.error ?? "No se pudo guardar la publicación.");
        await reloadPosts();
        return { id: result.post.id, brand: result.post.brand, status: result.post.status, message: "La pieza quedó guardada en el calendario; todavía no se publicó en Instagram." };
      },
    }, { signal: lifecycle.signal })).catch((error) => console.error("Unable to register calendar tool", error));
    return () => lifecycle.abort();
  }, [brands, reloadPosts]);

  const days = useMemo(() => Array.from({ length: 7 }, (_, index) => addDays(week, index)), [week]);
  const connectedBrands = brands.filter((item) => connectedAccounts[item.name]);
  const managedBrand = [...brands, ...archivedBrands].find((item) => item.id === editingBrandId);
  const isSelectedBrandConnected = Boolean(connectedAccounts[brand]);
  const scheduledPosts = posts.filter((post) => post.scheduledAt);
  const unscheduledPosts = posts.filter((post) => !post.scheduledAt);

  async function savePost(status: "draft" | "scheduled") {
    if (mediaType === "Historia" && selectedMediaFile?.type.startsWith("video/")) {
      setToast("Las historias automáticas admiten imágenes JPG o PNG. Selecciona una imagen.");
      return;
    }
    if (!caption.trim()) {
      setToast("Escribe el texto de la publicación antes de guardarla.");
      return;
    }
    if (status === "scheduled" && !scheduledAt) {
      setToast("Elige la fecha y hora de publicación.");
      return;
    }
    setSaving(true);
    try {
      let finalMediaUrl = uploadedMediaUrl;
      if (selectedMediaFile && !finalMediaUrl) {
        setUploadingMedia(true);
        const file = await prepareMediaFile(selectedMediaFile);
        const signedResponse = await fetch("/api/media/presign", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ contentType: file.type, size: file.size }) });
        const signed = await signedResponse.json() as { error?: string; uploadUrl?: string; mediaUrl?: string; headers?: Record<string, string> };
        if (!signedResponse.ok || !signed.uploadUrl || !signed.mediaUrl || !signed.headers) throw new Error(signed.error ?? "No se pudo preparar la carga del archivo.");
        const uploadResponse = await fetch(signed.uploadUrl, { method: "PUT", headers: signed.headers, body: file });
        if (!uploadResponse.ok) throw new Error("No se pudo cargar el archivo a la biblioteca. Revisa la configuración CORS del bucket R2.");
        finalMediaUrl = signed.mediaUrl;
        setUploadedMediaUrl(finalMediaUrl);
      }
      const response = await fetch(editingPostId ? `/api/posts/${editingPostId}` : "/api/posts", {
        method: editingPostId ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ brand, caption: caption.trim(), mediaType, mediaUrl: finalMediaUrl, scheduledAt: status === "scheduled" ? new Date(scheduledAt).toISOString() : null, status }),
      });
      const data = await response.json() as { error?: string; post: Post };
      if (!response.ok) throw new Error(data.error ?? "No se pudo guardar la publicación");
      setPosts((current) => [data.post, ...current.filter((item) => item.id !== data.post.id)]);
      setCaption("");
      setSelectedMediaFile(null);
      setUploadedMediaUrl("");
      setMediaPreview("");
      if (mediaInput.current) mediaInput.current.value = "";
      setDrawerOpen(false);
      setToast(status === "scheduled" ? "Guardada en el calendario. Se publicará a la hora programada si la cuenta y sus permisos están activos." : "Borrador guardado.");
      window.setTimeout(() => setToast(""), 5200);
    } catch (error) {
      setToast(error instanceof Error ? error.message : "No se pudo guardar la publicación");
    } finally {
      setUploadingMedia(false);
      setSaving(false);
    }
  }

  async function removePost(post: Post) {
    const action = post.status === "scheduled" ? "cancelar esta publicación programada" : "eliminar este elemento del calendario";
    if (!window.confirm(`¿Quieres ${action}?`)) return;
    try {
      const response = await fetch(`/api/posts/${post.id}`, { method: "DELETE" });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(data.error ?? "No se pudo cancelar la publicación.");
      setPosts((current) => current.filter((item) => item.id !== post.id));
      setToast(post.status === "scheduled" ? "Publicación cancelada." : "Elemento eliminado del calendario.");
    } catch (error) {
      setToast(error instanceof Error ? error.message : "No se pudo cancelar la publicación.");
    }
  }

  async function retryFacebookPost(post: Post) {
    try {
      const response = await fetch(`/api/posts/${post.id}/facebook/retry`, { method: "POST" });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(data.error ?? "No se pudo reintentar Facebook.");
      setToast("Reintento de Facebook agregado a la cola; se procesa automáticamente.");
      window.setTimeout(() => void reloadPosts(), 1500);
    } catch (error) {
      setToast(error instanceof Error ? error.message : "No se pudo reintentar Facebook.");
    }
  }

  function selectMedia(file: File | undefined) {
    if (!file) return;
    const isImage = file.type === "image/jpeg" || file.type === "image/png";
    const isVideo = file.type === "video/mp4";
    if (mediaType === "Historia" && isVideo) {
      setToast("Para una historia automática, elige una imagen JPG o PNG.");
      return;
    }
    if (!isImage && !isVideo) {
      setToast("Elige una imagen JPG/PNG o un video MP4.");
      return;
    }
    const maxSize = isImage ? 15 * 1024 * 1024 : 50 * 1024 * 1024;
    if (file.size > maxSize) {
      setToast(isImage ? "La imagen original debe pesar máximo 15 MB." : "El video debe pesar máximo 50 MB.");
      return;
    }
    setSelectedMediaFile(file);
    setUploadedMediaUrl("");
    setMediaPreview(URL.createObjectURL(file));
    if (isVideo) setMediaType("Reel");
    else setMediaType((current) => current === "Reel" ? "Imagen" : current);
  }

  function clearSelectedMedia() {
    setSelectedMediaFile(null);
    setUploadedMediaUrl("");
    setMediaPreview("");
    if (mediaInput.current) mediaInput.current.value = "";
  }

  function openComposer() {
    if (editingPostId) { setCaption(""); clearSelectedMedia(); setMediaType("Imagen"); }
    setEditingPostId(null);
    setDrawerOpen(true);
    setMobileMenu(false);
  }

  function editPost(post: Post) {
    setEditingPostId(post.id);
    setBrand(post.brand);
    setCaption(post.caption);
    setMediaType(post.mediaType);
    setSelectedMediaFile(null);
    setUploadedMediaUrl(post.mediaUrl ?? "");
    setMediaPreview(post.mediaUrl ?? "");
    setScheduledAt(post.scheduledAt ? localDateValue(new Date(post.scheduledAt)) : "");
    setDrawerOpen(true);
  }

  async function generateWithAgent() {
    if (agentBrief.trim().length < 8) {
      setAgentError("Describe el producto, servicio o tema para crear una publicación precisa.");
      return;
    }
    setAgentGenerating(true);
    setAgentError("");
    try {
      const response = await fetch("/api/agent/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ brand, objective: agentObjective, brief: agentBrief.trim(), callToAction: agentCallToAction.trim() }),
      });
      let data = await response.json() as AgentDraft & { error?: string; jobId?: string; status?: string };
      if (!response.ok) throw new Error(data.error ?? "No se pudo generar el contenido.");
      if (response.status === 202 && data.jobId) {
        const jobId = data.jobId;
        for (let attempt = 0; attempt < 120; attempt++) {
          await new Promise(resolve => setTimeout(resolve, 4000));
          const poll = await fetch(`/api/agent/generate?jobId=${encodeURIComponent(jobId)}`, { cache: "no-store" });
          data = await poll.json();
          if (!poll.ok || data.status === "failed") throw new Error(data.error ?? "La generación no se completó.");
          if (data.status === "completed") break;
        }
        if (data.status !== "completed") throw new Error("La generación está tardando demasiado. Revisa las funciones de Netlify antes de volver a intentar.");
      }
      const imageResponse = await fetch(data.mediaUrl, { cache: "no-store" });
      if (!imageResponse.ok) throw new Error("Se generó el copy, pero no pudimos abrir el creativo.");
      const nextPreview = URL.createObjectURL(await imageResponse.blob());
      setAgentPreviewUrl((current) => {
        if (current.startsWith("blob:")) URL.revokeObjectURL(current);
        return nextPreview;
      });
      setAgentDraft(data);
    } catch (error) {
      setAgentError(error instanceof Error ? error.message : "No se pudo generar el contenido.");
    } finally {
      setAgentGenerating(false);
    }
  }

  async function applyAgentDraft() {
    if (!agentDraft) return;
    try {
      const response = await fetch(agentDraft.mediaUrl, { cache: "no-store" });
      if (!response.ok) throw new Error("No pudimos preparar el creativo para el editor.");
      const blob = await response.blob();
      const source = new File([blob], "social-studio-creative.png", { type: blob.type || "image/png" });
      const jpeg = await prepareMediaFile(source);
      openComposer();
      setBrand(agentDraft.brand);
      setCaption(agentDraft.caption);
      setMediaType("Imagen");
      setSelectedMediaFile(jpeg);
      setUploadedMediaUrl("");
      setMediaPreview(URL.createObjectURL(jpeg));
      setAgentOpen(false);
    } catch (error) {
      setAgentError(error instanceof Error ? error.message : "No pudimos abrir el creativo.");
    }
  }

  function connectAccount(accountBrand: string) {
    // OAuth must navigate the whole browser to the route that starts Meta's redirect flow.
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination
    window.location.href = `/api/meta/connect?brand=${encodeURIComponent(accountBrand)}`;
  }

  function connectFacebookAccount(accountBrand: string) {
    // Facebook Login is a separate OAuth flow; Instagram Login has no Page publishing token.
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination
    window.location.href = `/api/meta/facebook/connect?brand=${encodeURIComponent(accountBrand)}`;
  }

  function connectBrandDrive(id: string) {
    // Starting Google's OAuth flow must navigate the top-level page.
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination
    window.location.href = `/api/brands/${id}/drive/connect`;
  }

  function editBrand(item: Brand) {
    setEditingBrandId(item.id);
    setBrandEssence(item.essence);
    setBrandWebsites(item.websiteUrls?.length ? [...item.websiteUrls] : [item.websiteUrl || ""]);
    setBrandDrive(item.driveFolderUrl);
    setBrandAutoSchedule(item.autoSchedule);
    setBrandAutoCrosspost(item.autoCrosspost);
    setBrandPostingDays(item.postingDays);
    setBrandPreferredTime(item.preferredTime);
    setBrandStoryTime(item.storyTime ?? "09:00");
    setBrandAutoStories(item.autoStories ?? true);
    setBrandAssets([]);
    setBrand(item.name);
    if (!item.id.startsWith("seed-")) {
      void fetch(`/api/brands/${item.id}/assets`, { cache: "no-store" })
        .then(async (response) => response.ok ? await response.json() as { assets?: BrandAsset[] } : { assets: [] })
        .then((data) => setBrandAssets(data.assets ?? []))
        .catch(() => setBrandAssets([]));
    }
  }

  async function openBrandManager(selected?: Brand) {
    let next = selected ?? brands[0];
    if (!next || next.id.startsWith("seed-")) {
      const active = await reloadBrands();
      next = selected ? (active.find((item) => item.name === selected.name) ?? active[0]) : active[0];
    }
    if (next) editBrand(next);
    else setEditingBrandId("");
    setBrandManagerOpen(true);
    setMobileMenu(false);
  }

  async function addBrand() {
    setBrandBusy(true);
    try {
      const response = await fetch("/api/brands", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: brandNameInput, handle: brandHandleInput }),
      });
      const data = await response.json() as { error?: string; brand?: Brand };
      if (!response.ok || !data.brand) throw new Error(data.error ?? "No se pudo agregar la marca.");
      setBrandNameInput(""); setBrandHandleInput("");
      await reloadBrands();
      editBrand(data.brand);
      setToast(`Marca ${data.brand.name} agregada. Ahora configura su agente y conecta Instagram.`);
    } catch (error) {
      setToast(error instanceof Error ? error.message : "No se pudo agregar la marca.");
    } finally { setBrandBusy(false); }
  }

  async function saveBrandProfile() {
    if (!managedBrand) return;
    if (brandAutoSchedule && brandEssence.trim().length < 20) {
      setToast("Escribe al menos 20 caracteres de esencia de marca antes de activar la programación autónoma.");
      return;
    }
    setBrandBusy(true);
    try {
      const response = await fetch(`/api/brands/${managedBrand.id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ essence: brandEssence, websiteUrls: brandWebsites.map(url => url.trim()).filter(Boolean), driveFolderUrl: brandDrive, autoSchedule: brandAutoSchedule, autoCrosspost: brandAutoCrosspost, postingDays: brandPostingDays, preferredTime: brandPreferredTime, storyTime: brandStoryTime, autoStories: brandAutoStories }),
      });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(data.error ?? "No se pudo guardar el perfil.");
      await reloadBrands();
      setToast(`Perfil del agente de ${managedBrand.name} guardado.`);
    } catch (error) {
      setToast(error instanceof Error ? error.message : "No se pudo guardar el perfil.");
    } finally { setBrandBusy(false); }
  }

  async function toggleBrandActive(item: Brand) {
    const action = item.active ? "quitar" : "restaurar";
    if (item.active && !window.confirm(`¿Quitar ${item.name} de las marcas activas? Su historial, archivos y cuenta conectada se conservarán. Se pausarán las piezas pendientes del agente; las publicaciones manuales conservarán su programación.`)) return;
    setBrandBusy(true);
    try {
      const response = await fetch(`/api/brands/${item.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ active: !item.active }) });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(data.error ?? `No se pudo ${action} la marca.`);
      const updatedBrands = await reloadBrands();
      if (item.active) {
        const next = updatedBrands.find((other) => other.id !== item.id);
        if (next) editBrand(next);
        else setEditingBrandId("");
      } else editBrand({ ...item, active: true });
      setToast(item.active ? `${item.name} se quitó de la lista activa; sus programaciones siguen en agenda.` : `${item.name} volvió a tus marcas activas.`);
    } catch (error) {
      setToast(error instanceof Error ? error.message : `No se pudo ${action} la marca.`);
    } finally { setBrandBusy(false); }
  }

  async function uploadBrandAsset(file?: File) {
    if (!file || !managedBrand) return;
    setBrandBusy(true);
    try {
      const signedResponse = await fetch(`/api/brands/${managedBrand.id}/assets/presign`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ contentType: file.type, size: file.size }) });
      const signed = await signedResponse.json() as { error?: string; uploadUrl?: string; headers?: Record<string, string>; assetId?: string; objectKey?: string };
      if (!signedResponse.ok || !signed.uploadUrl || !signed.headers || !signed.assetId || !signed.objectKey) throw new Error(signed.error ?? "No se pudo preparar la carga del archivo.");
      const upload = await fetch(signed.uploadUrl, { method: "PUT", headers: signed.headers, body: file });
      if (!upload.ok) throw new Error("No se pudo cargar el recurso. Revisa la configuración CORS del bucket R2.");
      const response = await fetch(`/api/brands/${managedBrand.id}/assets/${signed.assetId}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: file.name, contentType: file.type, size: file.size, objectKey: signed.objectKey }) });
      const data = await response.json() as { error?: string; asset?: BrandAsset };
      if (!response.ok || !data.asset) throw new Error(data.error ?? "No se pudo registrar el recurso.");
      setBrandAssets((current) => [data.asset!, ...current]);
      setToast("Recurso agregado a la biblioteca de la marca.");
    } catch (error) {
      setToast(error instanceof Error ? error.message : "No se pudo guardar el archivo.");
    } finally {
      if (brandAssetInput.current) brandAssetInput.current.value = "";
      setBrandBusy(false);
    }
  }

  async function removeBrandAsset(asset: BrandAsset) {
    if (!managedBrand) return;
    const response = await fetch(`/api/brands/${managedBrand.id}/assets/${asset.id}`, { method: "DELETE" });
    const data = await response.json() as { error?: string };
    if (!response.ok) { setToast(data.error ?? "No se pudo quitar el archivo."); return; }
    setBrandAssets((current) => current.filter((item) => item.id !== asset.id));
  }

  function togglePostingDay(day: number) {
    setBrandPostingDays((current) => current.includes(day) ? current.filter((value) => value !== day) : [...current, day].sort());
  }

  return (
    <main className="studio-shell">
      <aside className={`sidebar ${mobileMenu ? "sidebar-open" : ""}`}>
        <div className="brand-lockup">
          <div className="brand-mark"><Camera size={19} strokeWidth={2.1} /></div>
          <span>social<span className="brand-light">studio</span></span>
          <button className="icon-button sidebar-close" aria-label="Cerrar menú" onClick={() => setMobileMenu(false)}><X size={18} /></button>
        </div>

        <button className="workspace-select" aria-label="Espacio de trabajo">
          <span className="workspace-avatar">DM</span>
          <span className="workspace-copy"><strong>DM AI Solutions</strong><small>Espacio de trabajo</small></span>
          <MoreHorizontal size={17} />
        </button>

        <div className="side-label">GESTIÓN</div>
        <nav className="primary-nav" aria-label="Navegación principal">
          {navItems.map(({ label, icon: Icon, active }) => (
            <button key={label} className={`nav-item ${active ? "nav-active" : ""}`} onClick={() => label !== "Calendario" && setToast("Esta sección estará disponible en la siguiente etapa.")}>
              <Icon size={18} strokeWidth={1.9} /><span>{label}</span>{label === "Publicaciones" && <span className="nav-count">{posts.length}</span>}
            </button>
          ))}
        </nav>

        <div className="side-divider" />
        <div className="side-label side-label-row"><span>TUS MARCAS</span><button className="plain-icon" aria-label="Gestionar marcas" onClick={() => void openBrandManager()}><Plus size={16} /></button></div>
        <div className="brand-list">
          {brands.map((item) => (
              <button className="brand-row" key={item.name} onClick={() => { setBrand(item.name); openComposer(); }}>
              <span className="account-dot" style={{ background: item.color }}>{item.initials}</span>
              <span className="brand-row-name">{item.name}</span>
              <span className={`connection-dot ${connectedAccounts[item.name] ? "connected" : ""}`} title={connectedAccounts[item.name] ? `Conectada como @${connectedAccounts[item.name]}` : "Cuenta por conectar"} />
            </button>
          ))}
        </div>

        <div className="sidebar-bottom">
          <div className="meta-setup-card">
            <div className="meta-card-top"><span className="meta-icon"><Camera size={17} /></span><span className="setup-pulse" /></div>
            <strong>{connectedBrands.length ? `${connectedBrands.length} cuenta${connectedBrands.length === 1 ? "" : "s"} conectada${connectedBrands.length === 1 ? "" : "s"}` : "Conexión de Meta pendiente"}</strong>
            <p>{connectedBrands.length ? `${connectedBrands.map((item) => item.name).join(", ")} ya está autorizada. El siguiente paso es habilitar la carga de medios.` : "El siguiente paso es autorizar tus cuentas de Instagram."}</p>
            <button onClick={() => connectedBrands.length ? (setBrand(connectedBrands[0].name), openComposer()) : connectAccount(brands[0].name)}>{connectedBrands.length ? "Preparar publicación" : "Conectar Instagram"} <ChevronRight size={15} /></button>
          </div>
          <button className="nav-item settings-link" onClick={() => setToast("La configuración de Meta estará disponible cuando se conecte la primera cuenta.")}><Settings2 size={18} /><span>Configuración</span></button>
          <div className="profile-row"><span className="profile-avatar">DM</span><span><strong>David Marrugo</strong><small>Administrador</small></span><MoreHorizontal size={17} /></div>
        </div>
      </aside>

      {mobileMenu && <button className="mobile-scrim" aria-label="Cerrar menú" onClick={() => setMobileMenu(false)} />}

      <section className="main-area">
        <header className="topbar">
          <button className="icon-button mobile-menu-button" aria-label="Abrir menú" onClick={() => setMobileMenu(true)}><Menu size={21} /></button>
          <div className="breadcrumb"><span>Gestión</span><ChevronRight size={14} /><strong>Calendario</strong></div>
          <div className="topbar-actions">
            <span className="timezone-label"><Clock3 size={15} /> Bogotá · GMT−5</span>
            <button className="topbar-avatar" aria-label="Perfil">DM</button>
          </div>
        </header>

        <div className="content-wrap">
          <div className="page-heading">
            <div><div className="eyebrow"><span className="eyebrow-line" /> PLANIFICACIÓN DE CONTENIDO</div><h1>Calendario</h1><p>Organiza lo que vas a compartir en Instagram.</p></div>
            <button className="primary-button" onClick={openComposer}><CirclePlus size={18} /> Crear publicación</button>
          </div>

          <section className="quick-actions" aria-label="Acciones de contenido">
            <button className="agent-shortcut" onClick={() => { setAgentError(""); setAgentDraft(null); setAgentOpen(true); }}>
              <span className="agent-shortcut-icon"><Sparkles size={20} /></span>
              <span className="agent-shortcut-copy"><strong>Crear con agente</strong><small>Copy y creativo basados en la esencia y biblioteca de cada marca</small></span>
              <ChevronRight size={18} />
            </button>
            <button className="manage-brands-shortcut" onClick={() => void openBrandManager()}><Settings2 size={16} /> Gestionar marcas y agentes</button>
          </section>

          <section className="connection-banner">
            <div className="connection-symbol"><Camera size={18} /></div>
            <div className="connection-text"><strong>{connectedBrands.length ? `Instagram conectado${connectedBrands.length === 1 ? "" : "s"}: ${connectedBrands.map((item) => `@${connectedAccounts[item.name]}`).join(", ")}` : "Conecta una cuenta de Instagram"}</strong><span>{connectedBrands.length ? "Feed, Reels e historias de imagen se publican según el calendario y los permisos de cada cuenta." : "Autoriza tu cuenta profesional de Instagram para activar la publicación programada."}</span></div>
            <button className="banner-link" onClick={() => connectedBrands.length ? (setBrand(connectedBrands[0].name), openComposer()) : connectAccount(brands[0].name)}>{connectedBrands.length ? "Preparar contenido" : "Conectar cuenta"} <ChevronRight size={16} /></button>
            <button className="banner-dismiss" aria-label="Cerrar aviso" onClick={(event) => event.currentTarget.parentElement?.classList.add("banner-hidden")}><X size={16} /></button>
          </section>

          <section className="calendar-panel">
            <div className="calendar-toolbar">
              <div className="calendar-title"><h2>{format(week, "MMMM yyyy", { locale: es })}</h2><span className="calendar-view-label">Vista semanal</span></div>
              <div className="calendar-controls"><button className="today-button" onClick={() => setWeek(startOfWeek(new Date(), { weekStartsOn: 1 }))}>Hoy</button><button className="icon-button nav-arrow" aria-label="Semana anterior" onClick={() => setWeek(subWeeks(week, 1))}><ChevronLeft size={18} /></button><button className="icon-button nav-arrow" aria-label="Semana siguiente" onClick={() => setWeek(addWeeks(week, 1))}><ChevronRight size={18} /></button></div>
            </div>
            <div className="calendar-grid">
              {days.map((day) => {
                const items = scheduledPosts.filter((post) => post.scheduledAt && isSameDay(new Date(post.scheduledAt), day));
                const isToday = isSameDay(day, new Date());
                return <div className={`day-column ${isToday ? "day-today" : ""}`} key={day.toISOString()}>
                  <div className="day-heading"><span>{format(day, "EEE", { locale: es }).replace(".", "")}</span><b className={isToday ? "today-number" : ""}>{format(day, "d")}</b></div>
                  <div className="day-content">
                    {items.map((post) => { const account = brandFor(post.brand, brands); return <article className="calendar-post" key={post.id} style={{ "--brand-color": account.color } as React.CSSProperties}>
                      {post.status !== "published" && post.status !== "publishing" && <button className="calendar-post-edit" aria-label="Editar publicación" onClick={() => editPost(post)}><Settings2 size={12} /></button>}{post.status !== "published" && <button className="calendar-post-remove" aria-label="Cancelar publicación" title={post.publicationError ?? "Cancelar publicación programada"} onClick={() => void removePost(post)}><X size={12} /></button>}<div className="post-time">{format(new Date(post.scheduledAt!), "h:mm a", { locale: es })}</div><div className="post-brand">{account.name}</div><p>{post.caption}</p><span className="post-state">{statusLabel(post.status)}</span>
                    </article>; })}
                    {items.length === 0 && <button className="day-add" aria-label={`Crear publicación para ${format(day, "d MMMM", { locale: es })}`} onClick={() => { setScheduledAt(localDateValue(new Date(day.setHours(18, 0, 0, 0)))); openComposer(); }}><Plus size={15} /></button>}
                  </div>
                </div>;
              })}
            </div>
            <div className="calendar-foot"><span><span className="legend-dot legend-pending" /> En agenda</span><span><span className="legend-dot legend-draft" /> Borrador</span><span className="calendar-foot-note">La hora se muestra en Colombia.</span></div>
          </section>

          <section className="lower-grid">
            <div className="queue-panel">
              <div className="panel-heading"><div><h2>Próximas publicaciones</h2><p>Contenido guardado para tus marcas</p></div><button className="text-button" onClick={() => setToast("Todas las publicaciones ya aparecen en tu calendario.")}>Ver calendario <ChevronRight size={15} /></button></div>
              {loading ? <div className="empty-state"><span className="loader-dot" />Cargando calendario…</div> : loadError ? <div className="empty-state empty-error"><p>{loadError}</p><button onClick={() => void reloadPosts()}>Intentar de nuevo</button></div> : scheduledPosts.length === 0 && unscheduledPosts.length === 0 ? <div className="empty-state"><div className="empty-icon"><CalendarDays size={21} /></div><strong>Tu calendario está listo</strong><span>Programa la primera pieza para ver aquí tus próximas publicaciones.</span><button className="empty-cta" onClick={openComposer}><Plus size={16} /> Crear publicación</button></div> : <div className="queue-list">
                {[...scheduledPosts, ...unscheduledPosts].slice(0, 5).map((post) => { const account = brandFor(post.brand, brands); return <div className="queue-item" key={post.id}><span className="account-dot queue-avatar" style={{ background: account.color }}>{account.initials}</span><div className="queue-copy"><strong>{account.name}</strong><span>{post.caption}</span></div><div className="queue-date">{post.scheduledAt ? format(new Date(post.scheduledAt), "d MMM · h:mm a", { locale: es }) : "Sin fecha"}<small>{statusLabel(post.status)}{post.facebookStatus === "published" ? " · Facebook" : post.facebookStatus === "failed" ? " · Error en Facebook" : ""}</small></div>{post.status !== "published" && post.status !== "publishing" && <button className="plain-icon queue-more" aria-label="Editar publicación" onClick={() => editPost(post)}><Settings2 size={16} /></button>}{post.status !== "published" && <button className="plain-icon queue-more" aria-label={post.status === "scheduled" ? "Cancelar publicación" : "Eliminar elemento"} title={post.publicationError ?? post.facebookError ?? undefined} onClick={() => void removePost(post)}><Trash2 size={16} /></button>}{post.status === "published" && post.facebookStatus === "failed" && <button className="plain-icon queue-more" aria-label="Reintentar publicación en Facebook" title={post.facebookError ?? "Reintentar Facebook"} onClick={() => void retryFacebookPost(post)}><RefreshCw size={15} /></button>}</div>; })}
              </div>}
            </div>

            <aside className="accounts-panel"><div className="panel-heading"><div><h2>Cuentas</h2><p>Canales para publicar</p></div><button className="text-button manage-brands-inline" onClick={() => void openBrandManager()}>Gestionar marcas</button></div>
              <div className="account-connect-list">{brands.map((item) => <div className="account-connect-row" key={item.name}><span className="account-dot" style={{ background: item.color }}>{item.initials}</span><span className="account-connect-copy"><strong>{item.name}</strong><small>{connectedAccounts[item.name] ? `@${connectedAccounts[item.name]}` : item.handle}</small></span>{connectedAccounts[item.name] ? <span className="connected-label">Conectada</span> : <button className="connect-mini" onClick={() => connectAccount(item.name)}><Link2 size={14} /> Conectar</button>}</div>)}</div>
              <div className="account-note"><Sparkles size={16} /><span>{connectedBrands.length ? "Publicación automática activa para imágenes y Reels." : "Conecta una cuenta profesional de Instagram para activar la publicación automática."}</span></div>
            </aside>
          </section>

          <footer className="bottom-note"><MessageSquareText size={15} /><span>{connectedBrands.length ? "La publicación programada admite feed, Reels e historias de imagen, con conexiones y permisos vigentes." : "Lo que guardes aquí queda como planificación. Conecta Instagram para activar la publicación automática."}</span></footer>
        </div>
      </section>

      {brandManagerOpen && <div className="drawer-layer"><button className="drawer-backdrop" aria-label="Cerrar gestión de marcas" onClick={() => setBrandManagerOpen(false)} /><aside className="composer-drawer brand-manager-drawer" aria-label="Gestionar marcas y agentes">
        <div className="drawer-header"><div><span className="drawer-kicker">IDENTIDAD Y AUTOMATIZACIÓN</span><h2>Marcas y agentes</h2></div><button className="icon-button" aria-label="Cerrar" onClick={() => setBrandManagerOpen(false)}><X size={19} /></button></div>
        <div className="brand-add-box"><strong>Agregar una marca</strong><div className="brand-add-fields"><input className="field-control" maxLength={60} value={brandNameInput} onChange={(event) => setBrandNameInput(event.target.value)} placeholder="Nombre de la marca" /><input className="field-control" maxLength={40} value={brandHandleInput} onChange={(event) => setBrandHandleInput(event.target.value)} placeholder="Usuario de Instagram (opcional)" /><button className="primary-button" onClick={() => void addBrand()} disabled={brandBusy || brandNameInput.trim().length < 2}><Plus size={15} /> Agregar</button></div></div>
        <div className="managed-brand-list" aria-label="Marcas activas">{brands.map((item) => <button className={`managed-brand-chip ${editingBrandId === item.id ? "selected" : ""}`} key={item.id} onClick={() => editBrand(item)}><span className="account-dot" style={{ background: item.color }}>{item.initials}</span>{item.name}</button>)}</div>
        {managedBrand ? <>
          <div className="brand-agent-heading"><div className="account-dot" style={{ background: managedBrand.color }}>{managedBrand.initials}</div><div><strong>Agente de {managedBrand.name}</strong><span>Perfil independiente para esta marca</span></div><span className={`brand-status-pill ${managedBrand.active ? "" : "archived"}`}>{managedBrand.active ? "Activa" : "Archivada"}</span></div>
          <label className="field-label field-gap" htmlFor="brand-essence">Esencia y reglas de marca</label><textarea id="brand-essence" className="caption-control brand-essence-control" maxLength={4000} value={brandEssence} onChange={(event) => setBrandEssence(event.target.value)} placeholder="Describe personalidad, público, productos, beneficios confirmados, palabras que usa o evita y estilo visual…" /><div className="field-hint">El agente usa estas reglas para redactar el copy y crear los creativos.</div>
          <label className="field-label field-gap" htmlFor="brand-website-0"><Globe size={14} /> Sitios web y proyectos</label>
          <div className="brand-website-list">
            {brandWebsites.map((url, index) => <div className="brand-website-row" key={index}>
              <input id={`brand-website-${index}`} aria-label={`Sitio web ${index + 1}`} className="field-control" type="url" maxLength={2048} value={url} disabled={brandBusy} onChange={(event) => setBrandWebsites(current => current.map((value, position) => position === index ? event.target.value : value))} placeholder="https://proyecto.com" />
              <button type="button" className="icon-button" aria-label={`Quitar sitio web ${index + 1}`} title="Quitar sitio web" disabled={brandBusy} onClick={() => setBrandWebsites(current => current.length > 1 ? current.filter((_, position) => position !== index) : [""])}><X size={17} /></button>
            </div>)}
            <button type="button" className="secondary-button brand-website-add" disabled={brandBusy || brandWebsites.length >= 10} onClick={() => setBrandWebsites(current => current.length < 10 ? [...current, ""] : current)}><Plus size={14} /> Agregar sitio web <span>{brandWebsites.length}/10</span></button>
          </div>
          <div className="field-hint">Agrega hasta 10 páginas públicas con información e imágenes de tus proyectos. El agente consultará una fuente por pieza, sin mezclar precios, beneficios ni imágenes de proyectos distintos. Usa enlaces directos al proyecto y guarda los cambios.</div>
          <label className="field-label field-gap" htmlFor="brand-drive"><HardDrive size={14} /> Carpeta de Google Drive</label><input id="brand-drive" className="field-control" type="url" value={brandDrive} onChange={(event) => setBrandDrive(event.target.value)} placeholder="https://drive.google.com/drive/folders/..." /><div className="field-hint">Guarda el enlace de la carpeta y conecta Google para que el agente lea Docs, PDFs, imágenes y textos recientes.</div><div className="drive-connect-row">{managedBrand.driveConnected ? <span className="connected-label">Drive conectado</span> : <button className="connect-mini" disabled={!managedBrand.driveFolderUrl || brandBusy} onClick={() => connectBrandDrive(managedBrand.id)}><Link2 size={13} /> Conectar Google Drive</button>}<span>La conexión solo da acceso de lectura.</span></div>
          <div className="facebook-brand-box"><div><strong>Facebook</strong><small>{connectedFacebookPages[managedBrand.name] ? `Página vinculada: ${connectedFacebookPages[managedBrand.name]}` : "Vincula la Página asociada a Instagram"}</small></div>{!connectedFacebookPages[managedBrand.name] && <button className="connect-mini" disabled={!connectedAccounts[managedBrand.name]} onClick={() => connectFacebookAccount(managedBrand.name)}><Link2 size={13} /> Vincular</button>}<label className="autopilot-toggle facebook-crosspost-toggle"><input type="checkbox" checked={brandAutoCrosspost} disabled={!connectedFacebookPages[managedBrand.name]} onChange={(event) => setBrandAutoCrosspost(event.target.checked)} /><span><strong>Replicar en Facebook al publicar en Instagram</strong><small>Requiere Facebook Login y una Página vinculada a esta cuenta de Instagram.</small></span></label></div>
          <div className="field-label field-gap">Recursos de marca <span className="field-hint">Logos, brochures, imágenes de referencia y documentos</span></div>
          <input ref={brandAssetInput} type="file" accept="image/jpeg,image/png,image/webp,application/pdf,text/plain,text/markdown" hidden onChange={(event) => void uploadBrandAsset(event.target.files?.[0])} />
          <button className="asset-upload-button" onClick={() => brandAssetInput.current?.click()} disabled={brandBusy}><FileText size={16} /><span><strong>Agregar logo o brochure</strong><small>JPG, PNG, WebP, PDF, TXT o MD · hasta 15 MB</small></span><Plus size={16} /></button>
          {brandAssets.length > 0 && <div className="brand-asset-list">{brandAssets.map((asset) => <div className="brand-asset-row" key={asset.id}><FileText size={15} /><span>{asset.name}<small>{(asset.size / (1024 * 1024)).toFixed(1)} MB</small></span><button className="plain-icon" aria-label={`Quitar ${asset.name}`} onClick={() => void removeBrandAsset(asset)}><Trash2 size={14} /></button></div>)}</div>}
          <div className="autopilot-card"><label className="autopilot-toggle"><input type="checkbox" checked={brandAutoSchedule} onChange={(event) => { setBrandAutoSchedule(event.target.checked); if (event.target.checked && !managedBrand.automationStatus) { setBrandPostingDays([0, 1, 2, 3, 4, 5, 6]); setBrandAutoStories(true); } }} /><span><strong>Piloto automático · 15 días</strong><small>Prepara el feed y las historias de esta marca, publica según el calendario y renueva el siguiente bloque sin nuevas órdenes.</small></span></label>
            {brandAutoSchedule && <><div className="posting-day-picker" aria-label="Días de publicación">{[{ label: "L", value: 1 }, { label: "M", value: 2 }, { label: "X", value: 3 }, { label: "J", value: 4 }, { label: "V", value: 5 }, { label: "S", value: 6 }, { label: "D", value: 0 }].map((day) => <button type="button" key={day.value} className={brandPostingDays.includes(day.value) ? "day-selected" : ""} aria-pressed={brandPostingDays.includes(day.value)} onClick={() => togglePostingDay(day.value)}>{day.label}</button>)}</div><label className="field-label" htmlFor="brand-time">Feed · hora de Bogotá</label><input id="brand-time" className="field-control" type="time" value={brandPreferredTime} onChange={(event) => setBrandPreferredTime(event.target.value)} /><label className="autopilot-toggle field-gap"><input type="checkbox" checked={brandAutoStories} onChange={(event) => setBrandAutoStories(event.target.checked)} /><span><strong>Una historia de imagen por día seleccionado</strong><small>Una pieza vertical además de la publicación de feed.</small></span></label>{brandAutoStories && <><label className="field-label field-gap" htmlFor="brand-story-time">Historias · hora de Bogotá</label><input id="brand-story-time" className="field-control" type="time" value={brandStoryTime} onChange={(event) => setBrandStoryTime(event.target.value)} /></>}<p>Con todos los días seleccionados: 15 publicaciones de feed{brandAutoStories ? " y 15 historias" : ""} por ciclo. Facebook requiere la página vinculada y la opción de replicar activada. La generación utiliza tu saldo de API.</p></>}
            <p>La primera programación comienza mañana. Se activa una sola vez: no necesitas volver a abrir la app. Los cambios de días y horarios se aplican al próximo ciclo; puedes editar cada publicación del ciclo actual.</p><p>Al desactivar y guardar, se pausa la generación y la publicación de las piezas pendientes del agente. Tus publicaciones manuales conservan su programación.</p>
            {(agentConfigured === false || agentMissing.length > 0) && <div className="agent-error" role="status">Configuración pendiente: {agentMissing.length ? agentMissing.join(", ") : "revisa la conexión del agente y el almacenamiento"}. Completa la configuración para el funcionamiento autónomo.</div>}
            {!connectedAccounts[managedBrand.name] && <div className="field-hint">Falta conectar Instagram para publicar esta marca.</div>}
            <div className="automation-progress" aria-live="polite"><strong>{managedBrand.autoSchedule ? "Piloto habilitado en la configuración" : "Piloto pausado"}</strong>{managedBrand.automationStatus ? <><span>Ciclo: {managedBrand.automationStatus.cycleStart.slice(0, 10)} → {managedBrand.automationStatus.cycleEnd.slice(0, 10)}</span><progress max={Math.max(1, managedBrand.automationStatus.total)} value={managedBrand.automationStatus.planned} /><span>{managedBrand.automationStatus.planned} de {managedBrand.automationStatus.total} espacios atendidos (incluye omitidos) · {managedBrand.automationStatus.failed} con error</span>{managedBrand.automationStatus.lastError && <div className="agent-error">{managedBrand.automationStatus.lastError}</div>}</> : <span>Aún no hay un ciclo preparado. Guarda el perfil para que el agente lo procese cuando las conexiones estén listas.</span>}<button type="button" className="secondary-button" onClick={() => void reloadPosts()}>Actualizar estado</button></div>
          </div>
          <div className="brand-manager-actions"><button className="secondary-button" onClick={() => void toggleBrandActive(managedBrand)} disabled={brandBusy}>{managedBrand.active ? "Quitar marca" : "Restaurar marca"}</button><button className="primary-button" onClick={() => void saveBrandProfile()} disabled={brandBusy}>{brandBusy ? "Guardando…" : "Guardar perfil"}</button></div>
        </> : <div className="empty-state"><span>Agrega una marca para configurar su agente.</span></div>}
        {archivedBrands.length > 0 && <section className="archived-brand-section"><strong>Marcas quitadas</strong>{archivedBrands.map((item) => <button key={item.id} className="archived-brand-row" onClick={() => { editBrand(item); void toggleBrandActive(item); }}><span>{item.name}</span><span>Restaurar</span></button>)}</section>}
      </aside></div>}

      {agentOpen && <div className="drawer-layer"><button className="drawer-backdrop" aria-label="Cerrar agente creativo" onClick={() => setAgentOpen(false)} /><aside className="composer-drawer agent-drawer" aria-label="Agente creativo">
        <div className="drawer-header"><div><span className="drawer-kicker">ASISTENTE DE MARCA</span><h2>Crear con agente</h2></div><button className="icon-button" aria-label="Cerrar" onClick={() => setAgentOpen(false)}><X size={19} /></button></div>
        <p className="agent-intro">Recibe un copy, un concepto visual y un creativo cuadrado listos para revisar antes de programar.</p>
        <label className="field-label" htmlFor="agent-brand">Marca</label><select id="agent-brand" className="field-control" value={brand} onChange={(event) => setBrand(event.target.value)}>{brands.map((item) => <option key={item.name}>{item.name}</option>)}</select>
        <label className="field-label field-gap" htmlFor="agent-objective">Objetivo</label><select id="agent-objective" className="field-control" value={agentObjective} onChange={(event) => setAgentObjective(event.target.value)}><option>Ventas</option><option>Comunidad</option><option>Educación</option><option>Reconocimiento</option></select>
        <label className="field-label field-gap" htmlFor="agent-brief">¿Qué debe comunicar?</label><textarea id="agent-brief" className="caption-control" maxLength={600} value={agentBrief} onChange={(event) => setAgentBrief(event.target.value)} placeholder="Producto, servicio, tema, datos confirmados y público al que va dirigido…" />
        <label className="field-label field-gap" htmlFor="agent-cta">Llamada a la acción <span className="field-hint">Opcional</span></label><input id="agent-cta" className="field-control" maxLength={140} value={agentCallToAction} onChange={(event) => setAgentCallToAction(event.target.value)} placeholder="Ej. Escríbenos para más información" />
        <div className="agent-cost-note"><Sparkles size={15} /><span>Al generar, la API de OpenAI crea un texto y una imagen. El uso puede generar cargos en tu cuenta de API.</span></div>
        {agentError && <div className="agent-error" role="alert">{agentError}</div>}
        {(agentConfigured === false || agentMissing.length > 0) && <div className="agent-error" role="status">Configuración pendiente: {agentMissing.length ? agentMissing.join(", ") : "revisa la conexión del agente y el almacenamiento"}.</div>}
        {agentDraft && agentPreviewUrl && <section className="agent-result"><Image className="media-preview" src={agentPreviewUrl} alt="Creativo generado para Instagram" width={1024} height={1024} unoptimized /><strong>{agentDraft.headline}</strong><p>{agentDraft.caption}</p><small>{agentDraft.visualConcept}</small><details><summary>Ver prompt visual</summary><p>{agentDraft.imagePrompt}</p></details><button className="primary-button agent-use" onClick={() => void applyAgentDraft()}><ImagePlus size={16} /> Editar y programar</button></section>}
        <div className="drawer-footer"><button className="secondary-button" onClick={() => void generateWithAgent()} disabled={agentGenerating || agentConfigured === false}><Sparkles size={15} />{agentGenerating ? "Creando…" : agentConfigured === false ? "Configura la API" : agentDraft ? "Generar otra versión" : "Generar texto e imagen"}</button></div>
      </aside></div>}

      {drawerOpen && <div className="drawer-layer"><button className="drawer-backdrop" aria-label="Cerrar editor" onClick={() => setDrawerOpen(false)} /><aside className="composer-drawer" aria-label="Crear publicación">
        <div className="drawer-header"><div><span className="drawer-kicker">NUEVO CONTENIDO</span><h2>{editingPostId ? "Editar publicación" : "Crear publicación"}</h2></div><button className="icon-button" aria-label="Cerrar" onClick={() => setDrawerOpen(false)}><X size={19} /></button></div>
        <label className="field-label" htmlFor="post-brand">Cuenta de Instagram</label><select id="post-brand" className="field-control" disabled={Boolean(editingPostId)} value={brand} onChange={(event) => setBrand(event.target.value)}>{brands.map((item) => <option key={item.name}>{item.name}</option>)}</select><div className="field-hint">{isSelectedBrandConnected ? `Conectada como @${connectedAccounts[brand]}.` : "Esta cuenta todavía debe conectarse con Meta."}</div>
        <label className="field-label field-gap" htmlFor="post-caption">Texto de la publicación</label><textarea id="post-caption" className="caption-control" maxLength={2200} value={caption} onChange={(event) => setCaption(event.target.value)} placeholder="¿Qué quieres compartir con tu comunidad?" /><div className="character-count">{caption.length} / 2.200 caracteres</div>
        <label className="field-label field-gap" htmlFor="media-type">Formato</label><select id="media-type" className="field-control" value={mediaType} onChange={(event) => { if (event.target.value !== mediaType) clearSelectedMedia(); setMediaType(event.target.value); }}><option>Imagen</option><option>Reel</option><option>Historia</option></select>
        <input ref={mediaInput} type="file" accept={mediaType === "Reel" ? "video/mp4" : "image/jpeg,image/png"} style={{ display: "none" }} onChange={(event) => selectMedia(event.target.files?.[0])} />
        <div className="media-drop" role="button" tabIndex={0} onClick={() => mediaInput.current?.click()} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); mediaInput.current?.click(); } }}><span className="media-icon"><ImagePlus size={20} /></span><span><strong>{selectedMediaFile?.name ?? "Agrega una imagen o video"}</strong><small>{selectedMediaFile ? `${(selectedMediaFile.size / (1024 * 1024)).toFixed(1)} MB · ${uploadedMediaUrl ? "Cargado" : "Se cargará al guardar"}` : mediaType === "Reel" ? "Video MP4 · máximo 50 MB" : "JPG o PNG · máximo 15 MB antes de optimizar"}</small></span><ChevronRight size={16} /></div>
        {selectedMediaFile && <button type="button" className="text-button media-remove" onClick={clearSelectedMedia}>Quitar archivo</button>}
        {mediaPreview && (mediaType === "Reel" ? <video className="media-preview" src={mediaPreview} controls /> : <Image className="media-preview" src={mediaPreview} alt="Vista previa del contenido" width={1200} height={1200} unoptimized />)}
        <label className="field-label field-gap" htmlFor="post-schedule">Fecha y hora</label><input id="post-schedule" type="datetime-local" className="field-control" value={scheduledAt} onChange={(event) => setScheduledAt(event.target.value)} />
        <div className="schedule-hint"><Clock3 size={16} /><span>Las publicaciones y las historias de imagen se enviarán a la hora elegida, según la conexión y los permisos de cada cuenta.</span></div>
        <div className="drawer-footer"><button className="secondary-button" onClick={() => void savePost("draft")} disabled={saving}>Guardar borrador</button><button className="primary-button" onClick={() => void savePost("scheduled")} disabled={saving}><Send size={16} />{uploadingMedia ? "Subiendo…" : saving ? "Guardando…" : editingPostId ? "Guardar cambios" : "Programar"}</button></div>
      </aside></div>}

      {toast && <div className="toast-message" role="status">{toast}<button aria-label="Cerrar aviso" onClick={() => setToast("")}><X size={15} /></button></div>}
    </main>
  );
}
