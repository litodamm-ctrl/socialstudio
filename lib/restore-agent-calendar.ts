/** Explicit, idempotent recovery: reuse existing creatives, never recreate deleted posts. */
export async function restoreAgentCalendar(db: D1Database, owner: string, brandId: string, username: string, now = Date.now()) {
  const cutoff = new Date(now + 15 * 60_000).toISOString();
  const eligible = `SELECT b.name FROM brand_registry b JOIN instagram_accounts a ON a.owner_id = b.owner_id AND a.brand = b.name
    WHERE b.owner_id = ? AND b.id = ? AND b.active = 1 AND b.auto_schedule = 1 AND a.username = ?`;
  const restored = await db.prepare(`UPDATE posts SET status = 'scheduled', scheduled_at = (
    SELECT s.scheduled_at FROM autopilot_slots s WHERE s.post_id = posts.id AND s.owner_id = posts.owner_id AND s.brand_id = ? AND s.status = 'completed' LIMIT 1)
    WHERE owner_id = ? AND brand IN (${eligible}) AND status = 'draft' AND scheduled_at IS NULL
    AND media_url IS NOT NULL AND length(media_url) > 0
    AND NOT EXISTS (SELECT 1 FROM instagram_publish_jobs j WHERE j.post_id = posts.id)
    AND EXISTS (SELECT 1 FROM autopilot_slots s JOIN brand_registry b ON b.id = s.brand_id AND b.owner_id = s.owner_id
      WHERE s.post_id = posts.id AND s.owner_id = posts.owner_id AND s.brand_id = ? AND s.status = 'completed' AND s.scheduled_at > ?
      AND (s.media_type <> 'Historia' OR b.auto_stories = 1)
      AND NOT EXISTS (SELECT 1 FROM posts p WHERE p.owner_id = posts.owner_id AND p.brand = posts.brand AND p.id <> posts.id
        AND p.status IN ('scheduled','publishing','published') AND p.scheduled_at = s.scheduled_at AND p.media_type = posts.media_type)) RETURNING id`)
    .bind(brandId, owner, owner, brandId, username, brandId, cutoff).all<{ id: string }>();
  const retried = await db.prepare(`UPDATE autopilot_slots SET status = 'pending', attempts = 0, claim_id = NULL, last_error = NULL, updated_at = ?
    WHERE owner_id = ? AND brand_id = ? AND post_id IS NULL AND scheduled_at > ?
    AND (status = 'failed' OR (status = 'skipped' AND last_error = 'Conexión modificada; revisa la programación.'))
    AND EXISTS (SELECT 1 FROM brand_registry b WHERE b.id = autopilot_slots.brand_id AND b.owner_id = autopilot_slots.owner_id
      AND b.name IN (${eligible}) AND (autopilot_slots.media_type <> 'Historia' OR b.auto_stories = 1)) RETURNING id`)
    .bind(now, owner, brandId, cutoff, owner, brandId, username).all<{ id: string }>();
  return { restored: restored.results?.length ?? 0, retried: retried.results?.length ?? 0 };
}
