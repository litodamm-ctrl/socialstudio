/** Story text must already be rendered into the image: Meta does not use feed captions here. */
export function instagramMediaForm(format: string, mediaUrl: string, caption: string) {
  const form = new URLSearchParams();
  if (format === "Reel") {
    form.set("media_type", "REELS");
    form.set("video_url", mediaUrl);
    form.set("share_to_feed", "true");
  } else if (format === "Imagen" || format === "Historia") {
    form.set("image_url", mediaUrl);
    if (format === "Historia") form.set("media_type", "STORIES");
  } else throw new Error("Formato de publicación no compatible.");
  if (format !== "Historia") form.set("caption", caption);
  return form;
}

export async function publishFacebookPhotoStory(options: {
  pageId: string; token: string; graphVersion: string; mediaUrl: string;
  photoId?: string | null; savePhotoId: (id: string) => Promise<void>; beforePublish?: () => Promise<void>;
}, request: typeof fetch = fetch) {
  const endpoint = `https://graph.facebook.com/${options.graphVersion}/${options.pageId}`;
  const send = async (path: string, body: URLSearchParams) => {
    const response = await request(`${endpoint}/${path}`, {
      method: "POST", headers: { Authorization: `Bearer ${options.token}`, "content-type": "application/x-www-form-urlencoded" }, body,
      signal: AbortSignal.timeout(60_000),
    });
    const data = await response.json() as { id?: string; post_id?: string; success?: boolean; error?: { message?: string } };
    if (!response.ok || data.error) throw new Error(data.error?.message?.slice(0, 260) ?? "Facebook rechazó la historia.");
    return data;
  };
  let photoId = options.photoId;
  if (!photoId) {
    const uploaded = await send("photos", new URLSearchParams({ url: options.mediaUrl, published: "false" }));
    if (!uploaded.id) throw new Error("Facebook no confirmó la carga de la imagen para la historia.");
    photoId = uploaded.id;
    await options.savePhotoId(photoId);
  }
  // Do not automatically retry an ambiguous final send: it may already be visible.
  await options.beforePublish?.();
  const published = await send("photo_stories", new URLSearchParams({ photo_id: photoId }));
  if (published.success === false || !(published.post_id || published.id)) {
    throw new Error("No se pudo confirmar la historia. Revisa Facebook antes de reintentar.");
  }
  return (published.post_id || published.id)!;
}
// Correlated against posts alias p. Manual posts have no autopilot slot.
export const AUTOPILOT_ALLOWED_SQL = `(NOT EXISTS (SELECT 1 FROM autopilot_slots s WHERE s.post_id = p.id AND s.owner_id = p.owner_id)
  OR (p.scheduled_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 day') AND EXISTS (
    SELECT 1 FROM autopilot_slots s JOIN brand_registry ab ON ab.id = s.brand_id AND ab.owner_id = s.owner_id
    WHERE s.post_id = p.id AND s.owner_id = p.owner_id AND ab.active = 1 AND ab.auto_schedule = 1
    AND (p.media_type != 'Historia' OR ab.auto_stories = 1))))`;
export const POST_SNAPSHOT_SQL = `p.id = instagram_publish_jobs.post_id AND p.owner_id = ? AND p.status = 'scheduled'
  AND p.scheduled_at <= ? AND p.brand = ? AND p.caption = ? AND p.media_type = ? AND p.media_url = ? AND p.scheduled_at = ?`;
