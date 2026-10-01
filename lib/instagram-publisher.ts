import { decryptInstagramToken, encryptInstagramToken, graphUrl, instagramApiError } from "@/lib/meta";
import { ensureFacebookTables } from "@/lib/facebook";
import { ensureBrandRegistry } from "@/lib/brands";
import { createR2PresignedUrl } from "@/lib/runtime";

const JOB_TABLE_SQL = `CREATE TABLE IF NOT EXISTS instagram_publish_jobs (
  post_id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'publishing', 'published', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  container_id TEXT,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  lease_until INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  published_media_id TEXT,
  facebook_status TEXT NOT NULL DEFAULT 'skipped' CHECK (facebook_status IN ('skipped', 'pending', 'publishing', 'published', 'failed')),
  facebook_media_id TEXT,
  facebook_error TEXT,
  updated_at INTEGER NOT NULL
)`;

type PublisherBindings = {
  DB?: D1Database;
  BUCKET?: R2Bucket;
  META_GRAPH_VERSION?: string;
};

type DuePost = {
  post_id: string;
  owner_id: string;
  brand: string;
  caption: string;
  media_type: string;
  media_url: string;
  scheduled_at: string;
  instagram_user_id: string | null;
  encrypted_token: string | null;
  token_expires_at: number | null;
  container_id: string | null;
  attempts: number;
  auto_crosspost: number;
};

type GraphResult = { id?: string; status_code?: string; success?: boolean; error?: { message?: string } };

async function ensureJobTable(db: D1Database) {
  await db.prepare(JOB_TABLE_SQL).run();
  for (const [column, definition] of [["facebook_status", "TEXT NOT NULL DEFAULT 'skipped'"], ["facebook_media_id", "TEXT"], ["facebook_error", "TEXT"]]) {
    try { await db.prepare(`ALTER TABLE instagram_publish_jobs ADD COLUMN ${column} ${definition}`).run(); }
    catch (error) { if (!(error instanceof Error) || !/duplicate column name/i.test(error.message)) throw error; }
  }
}

async function graphJson(response: Response): Promise<GraphResult> {
  const value = await response.json() as GraphResult;
  if (!response.ok) throw await instagramApiError(new Response(JSON.stringify(value), { status: response.status }));
  return value;
}

async function getAccessToken(db: D1Database, post: DuePost) {
  if (!post.encrypted_token || !post.instagram_user_id || !post.token_expires_at) {
    throw new Error("Conecta la cuenta de Instagram de esta marca antes de publicar.");
  }
  let token = await decryptInstagramToken(post.encrypted_token);
  if (post.token_expires_at < Date.now() + 7 * 24 * 60 * 60 * 1000) {
    const refreshUrl = new URL("https://graph.instagram.com/refresh_access_token");
    refreshUrl.searchParams.set("grant_type", "ig_refresh_token");
    refreshUrl.searchParams.set("access_token", token);
    const refreshed = await graphJson(await fetch(refreshUrl));
    if (!(refreshed as GraphResult & { access_token?: string }).access_token) {
      throw new Error("Instagram no pudo renovar el acceso. Vuelve a conectar la cuenta.");
    }
    const newToken = (refreshed as GraphResult & { access_token: string }).access_token;
    const expiresIn = Number((refreshed as GraphResult & { expires_in?: number }).expires_in ?? 0);
    if (!expiresIn) throw new Error("Instagram no devolvió la vigencia del acceso renovado.");
    await db.prepare("UPDATE instagram_accounts SET encrypted_token = ?, token_expires_at = ?, updated_at = ? WHERE owner_id = ? AND brand = ?")
      .bind(await encryptInstagramToken(newToken), Date.now() + expiresIn * 1000, Date.now(), post.owner_id, post.brand).run();
    token = newToken;
  }
  return token;
}

async function fail(db: D1Database, postId: string, error: string) {
  await db.prepare("UPDATE instagram_publish_jobs SET status = 'failed', lease_until = 0, last_error = ?, updated_at = ? WHERE post_id = ?")
    .bind(error.slice(0, 400), Date.now(), postId).run();
}

async function processOne(db: D1Database, bucket: R2Bucket | undefined, post: DuePost, graphVersion = "v26.0") {
  const now = Date.now();
  const lock = await db.prepare(
    "UPDATE instagram_publish_jobs SET status = 'processing', attempts = attempts + 1, lease_until = ?, updated_at = ? WHERE post_id = ? AND status = 'pending' AND next_attempt_at <= ? RETURNING post_id",
  ).bind(now + 5 * 60_000, now, post.post_id, now).first<{ post_id: string }>();
  if (!lock) return;

  if (!post.media_url || !bucket) {
    await fail(db, post.post_id, "Añade una imagen o un video antes de programar la publicación.");
    return;
  }
  if (post.media_type === "Historia") {
    await fail(db, post.post_id, "La publicación automática de Historias aún no está habilitada. Cambia el formato o publícala manualmente.");
    return;
  }

  let stage: "container" | "publish" = "container";
  try {
    const objectId = post.media_url.match(/^\/api\/media\/([0-9a-f-]{36})$/i)?.[1];
    if (!objectId) throw new Error("El archivo adjunto ya no está disponible.");
    const object = await bucket.head(`media/${objectId}`);
    if (!object || object.customMetadata?.ownerId !== post.owner_id) throw new Error("El archivo adjunto ya no está disponible.");
    const contentType = object.httpMetadata?.contentType;
    if (post.media_type === "Imagen" && contentType !== "image/jpeg") throw new Error("Para una publicación de imagen, adjunta un archivo JPG.");
    if (post.media_type === "Reel" && contentType !== "video/mp4") throw new Error("Para un Reel, adjunta un video MP4.");

    const token = await getAccessToken(db, post);
    let containerId = post.container_id;
    if (!containerId) {
      const mediaUrl = await createR2PresignedUrl("GET", `media/${objectId}`, {}, 7200);
      const form = new URLSearchParams();
      if (post.media_type === "Reel") {
        form.set("media_type", "REELS");
        form.set("video_url", mediaUrl);
        form.set("share_to_feed", "true");
      } else {
        form.set("image_url", mediaUrl);
      }
      form.set("caption", post.caption);
      const created = await graphJson(await fetch(graphUrl(`${post.instagram_user_id}/media`), {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "content-type": "application/x-www-form-urlencoded" },
        body: form,
      }));
      if (!created.id) throw new Error("Instagram no devolvió el identificador de la publicación.");
      containerId = created.id;
      await db.prepare("UPDATE instagram_publish_jobs SET container_id = ?, updated_at = ? WHERE post_id = ?")
        .bind(containerId, Date.now(), post.post_id).run();
    }

    const containerUrl = new URL(graphUrl(containerId));
    containerUrl.searchParams.set("fields", "status_code");
    const container = await graphJson(await fetch(containerUrl, { headers: { Authorization: `Bearer ${token}` } }));
    if (container.status_code === "IN_PROGRESS") {
      await db.prepare("UPDATE instagram_publish_jobs SET status = 'pending', lease_until = 0, next_attempt_at = ?, updated_at = ? WHERE post_id = ?")
        .bind(Date.now() + 60_000, Date.now(), post.post_id).run();
      return;
    }
    if (container.status_code !== "FINISHED") {
      await fail(db, post.post_id, "Instagram no pudo procesar el archivo. Revisa el formato y la duración.");
      return;
    }

    stage = "publish";
    await db.prepare("UPDATE instagram_publish_jobs SET status = 'publishing', updated_at = ? WHERE post_id = ?")
      .bind(Date.now(), post.post_id).run();
    const form = new URLSearchParams({ creation_id: containerId });
    const published = await graphJson(await fetch(graphUrl(`${post.instagram_user_id}/media_publish`), {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/x-www-form-urlencoded" },
      body: form,
    }));
    if (!published.id) throw new Error("Instagram no confirmó que la publicación se completara.");
    await db.prepare("UPDATE instagram_publish_jobs SET status = 'published', lease_until = 0, published_media_id = ?, last_error = NULL, facebook_status = ?, facebook_error = NULL, updated_at = ? WHERE post_id = ?")
      .bind(published.id, post.auto_crosspost ? "pending" : "skipped", Date.now(), post.post_id).run();
    if (post.auto_crosspost) {
      try {
        await db.prepare("UPDATE instagram_publish_jobs SET facebook_status = 'publishing', updated_at = ? WHERE post_id = ?")
          .bind(Date.now(), post.post_id).run();
        const facebookMediaId = await publishToFacebook(db, bucket, post, graphVersion);
        await db.prepare("UPDATE instagram_publish_jobs SET facebook_status = 'published', facebook_media_id = ?, facebook_error = NULL, updated_at = ? WHERE post_id = ?")
          .bind(facebookMediaId, Date.now(), post.post_id).run();
      } catch (error) {
        const facebookError = error instanceof Error ? error.message.slice(0, 300) : "No se pudo publicar en Facebook.";
        await db.prepare("UPDATE instagram_publish_jobs SET facebook_status = 'failed', facebook_error = ?, updated_at = ? WHERE post_id = ?")
          .bind(facebookError, Date.now(), post.post_id).run();
        console.error("Facebook crosspost failed after Instagram publication", post.post_id, facebookError);
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 400) : "No se pudo publicar en Instagram.";
    if (stage === "publish") {
      await fail(db, post.post_id, `No se pudo confirmar el envío a Instagram. Revisa la cuenta antes de reintentar. ${message}`);
      return;
    }
    const attempts = post.attempts + 1;
    if (attempts < 4) {
      await db.prepare("UPDATE instagram_publish_jobs SET status = 'pending', lease_until = 0, next_attempt_at = ?, last_error = ?, updated_at = ? WHERE post_id = ?")
        .bind(Date.now() + Math.min(15 * 60_000, 60_000 * 2 ** attempts), message, Date.now(), post.post_id).run();
      console.error("Instagram publication will retry", post.post_id, message);
      return;
    }
    await fail(db, post.post_id, message);
  }
}

async function publishToFacebook(db: D1Database, bucket: R2Bucket | undefined, post: DuePost, graphVersion: string) {
  await ensureFacebookTables(db);
  if (!bucket) throw new Error("La biblioteca multimedia no está disponible para Facebook.");
  const account = await db.prepare("SELECT page_id, encrypted_page_token, token_expires_at FROM facebook_accounts WHERE owner_id = ? AND brand = ?")
    .bind(post.owner_id, post.brand).first<{ page_id: string; encrypted_page_token: string; token_expires_at: number }>();
  if (!account) throw new Error("Vincula la Página de Facebook asociada a esta marca.");
  if (account.token_expires_at <= Date.now()) throw new Error("El acceso a Facebook venció. Vuelve a vincular la Página.");
  const token = await decryptInstagramToken(account.encrypted_page_token);
  const objectId = post.media_url.match(/^\/api\/media\/([0-9a-f-]{36})$/i)?.[1];
  if (!objectId) throw new Error("El archivo no está disponible para el cruce a Facebook.");
  const object = await bucket.head(`media/${objectId}`);
  if (!object || object.customMetadata?.ownerId !== post.owner_id) throw new Error("El archivo de esta marca no está disponible.");
  const mediaUrl = await createR2PresignedUrl("GET", `media/${objectId}`, {}, 7200);

  if (post.media_type === "Imagen") {
    const form = new URLSearchParams({ url: mediaUrl, message: post.caption, access_token: token });
    const result = await facebookJson(await fetch(`https://graph.facebook.com/${graphVersion}/${account.page_id}/photos`, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form,
    }));
    if (!result.id) throw new Error("Facebook no confirmó que la imagen se publicara.");
    return result.id;
  }
  if (post.media_type !== "Reel") throw new Error("El cruce automático admite imágenes y Reels.");
  const body = await bucket.get(`media/${objectId}`);
  if (!body) throw new Error("El video no está disponible para Facebook.");
  const videoBytes = await body.arrayBuffer();
  const startUrl = new URL(`https://graph.facebook.com/${graphVersion}/${account.page_id}/video_reels`);
  startUrl.searchParams.set("upload_phase", "start");
  startUrl.searchParams.set("access_token", token);
  const started = await facebookJson(await fetch(startUrl, { method: "POST" })) as GraphResult & { video_id?: string; upload_url?: string };
  if (!started.video_id || !started.upload_url) throw new Error("Facebook no inició la carga del Reel.");
  const videoId = started.video_id;
  const uploadUrl = started.upload_url;
  const upload = await fetch(uploadUrl, {
    method: "POST",
    headers: { Authorization: `OAuth ${token}`, offset: "0", file_size: String(videoBytes.byteLength), "content-type": "application/octet-stream" },
    body: videoBytes,
  });
  const uploadResult = await upload.json() as { success?: boolean; error?: { message?: string } };
  if (!upload.ok || !uploadResult.success) throw new Error(uploadResult.error?.message ?? "Facebook no aceptó el archivo de video.");
  const finishUrl = new URL(`https://graph.facebook.com/${graphVersion}/${account.page_id}/video_reels`);
  finishUrl.searchParams.set("upload_phase", "finish");
  finishUrl.searchParams.set("video_state", "PUBLISHED");
  finishUrl.searchParams.set("video_id", videoId);
  finishUrl.searchParams.set("description", post.caption);
  finishUrl.searchParams.set("access_token", token);
  const finished = await facebookJson(await fetch(finishUrl, { method: "POST" }));
  if (finished.success === false) throw new Error("Facebook no confirmó la publicación del Reel.");
  return videoId;
}

async function facebookJson(response: Response): Promise<GraphResult> {
  const data = await response.json() as GraphResult;
  if (!response.ok || data.error) throw new Error(data.error?.message?.slice(0, 260) ?? "Facebook rechazó la publicación.");
  return data;
}

export async function processDueInstagramPublications(bindings: PublisherBindings) {
  const db = bindings.DB;
  if (!db) return;
  await ensureBrandRegistry(db);
  await ensureJobTable(db);
  const now = Date.now();
  await db.prepare("UPDATE instagram_publish_jobs SET status = 'failed', lease_until = 0, last_error = 'El envío se interrumpió. Revisa Instagram antes de reintentar.', updated_at = ? WHERE status = 'publishing' AND lease_until < ?")
    .bind(now, now).run();
  await db.prepare("UPDATE instagram_publish_jobs SET status = 'pending', lease_until = 0, updated_at = ? WHERE status = 'processing' AND lease_until < ?")
    .bind(now, now).run();
  await db.prepare(`INSERT OR IGNORE INTO instagram_publish_jobs (post_id, owner_id, status, attempts, next_attempt_at, updated_at)
    SELECT id, owner_id, 'pending', 0, 0, ? FROM posts WHERE status = 'scheduled' AND scheduled_at IS NOT NULL AND scheduled_at <= ?`)
    .bind(now, new Date(now).toISOString()).run();

  const result = await db.prepare(`SELECT j.post_id, j.owner_id, j.attempts, j.container_id,
      p.brand, p.caption, p.media_type, p.media_url, p.scheduled_at,
      a.instagram_user_id, a.encrypted_token, a.token_expires_at, COALESCE(b.auto_crosspost, 0) AS auto_crosspost
    FROM instagram_publish_jobs j
    JOIN posts p ON p.id = j.post_id
    LEFT JOIN instagram_accounts a ON a.owner_id = p.owner_id AND a.brand = p.brand
    LEFT JOIN brand_registry b ON b.owner_id = p.owner_id AND b.name = p.brand
    WHERE j.status = 'pending' AND j.next_attempt_at <= ?
    ORDER BY p.scheduled_at ASC LIMIT 5`).bind(now).all<DuePost>();

  for (const post of result.results ?? []) await processOne(db, bindings.BUCKET, post, bindings.META_GRAPH_VERSION);

  const facebookRetries = await db.prepare(`SELECT p.id AS post_id, p.owner_id, p.brand, p.caption, p.media_type, p.media_url,
      0 AS attempts, 0 AS auto_crosspost, j.published_media_id, j.updated_at
    FROM instagram_publish_jobs j JOIN posts p ON p.id = j.post_id
    JOIN brand_registry b ON b.owner_id = p.owner_id AND b.name = p.brand
    WHERE j.status = 'published' AND j.facebook_status = 'pending' AND b.auto_crosspost = 1
    ORDER BY j.updated_at ASC LIMIT 5`).all<DuePost & { published_media_id: string | null; updated_at: number }>();
  for (const post of facebookRetries.results ?? []) {
    const facebookLock = await db.prepare("UPDATE instagram_publish_jobs SET facebook_status = 'publishing', updated_at = ? WHERE post_id = ? AND facebook_status = 'pending' RETURNING post_id")
      .bind(Date.now(), post.post_id).first<{ post_id: string }>();
    if (!facebookLock) continue;
    try {
      const facebookMediaId = await publishToFacebook(db, bindings.BUCKET, post, bindings.META_GRAPH_VERSION || "v26.0");
      await db.prepare("UPDATE instagram_publish_jobs SET facebook_status = 'published', facebook_media_id = ?, facebook_error = NULL, updated_at = ? WHERE post_id = ?")
        .bind(facebookMediaId, Date.now(), post.post_id).run();
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 300) : "No se pudo publicar en Facebook.";
      await db.prepare("UPDATE instagram_publish_jobs SET facebook_status = 'failed', facebook_error = ?, updated_at = ? WHERE post_id = ?")
        .bind(message, Date.now(), post.post_id).run();
    }
  }
}

export async function ensureInstagramPublishJobs(db: D1Database) {
  await ensureJobTable(db);
}
