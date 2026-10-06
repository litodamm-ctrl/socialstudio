/** Explicit recovery preserves completed/removed slots and ignores expired publication dates. */
export async function retryFailedSlots(db: D1Database, ownerId: string, brandId: string, now = Date.now()) {
  const result = await db.prepare(`UPDATE autopilot_slots SET status = 'pending', attempts = 0,
    claim_id = NULL, last_error = NULL, updated_at = ?
    WHERE owner_id = ? AND brand_id = ? AND status = 'failed' AND post_id IS NULL AND scheduled_at > ?
    AND EXISTS (SELECT 1 FROM brand_registry b WHERE b.id = autopilot_slots.brand_id
      AND b.owner_id = autopilot_slots.owner_id AND b.active = 1 AND b.auto_schedule = 1
      AND (autopilot_slots.media_type <> 'Historia' OR b.auto_stories = 1))
    RETURNING id`)
    .bind(now, ownerId, brandId, new Date(now + 15 * 60_000).toISOString()).all<{ id: string }>();
  return result.results?.length ?? 0;
}
