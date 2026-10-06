export async function changeInstagramConnection(db: D1Database, owner: string, source: string, username: string, target?: string) {
  const destination = target || source;
  // Every statement checks the same guard within one atomic D1 batch. An active
  // publisher must finish first; old tokens may already be in that worker's memory.
  const guard = `EXISTS (SELECT 1 FROM instagram_accounts a WHERE a.owner_id = ? AND a.brand = ? AND a.username = ?)
    AND EXISTS (SELECT 1 FROM brand_registry b WHERE b.owner_id = ? AND b.name = ? AND b.active = 1)
    AND NOT EXISTS (SELECT 1 FROM instagram_publish_jobs j JOIN posts p ON p.id = j.post_id
      WHERE p.owner_id = ? AND p.brand IN (?, ?) AND (j.status IN ('processing','publishing') OR j.facebook_status = 'publishing'))
    ${target ? "AND NOT EXISTS (SELECT 1 FROM instagram_accounts a WHERE a.owner_id = ? AND a.brand = ?)" : ""}`;
  const args = [owner, source, username, owner, destination, owner, source, destination, ...(target ? [owner, target] : [])];
  const now = Date.now();
  const statements = [
    db.prepare(`UPDATE brand_registry SET auto_schedule = 0, auto_crosspost = 0, updated_at = ? WHERE owner_id = ? AND name IN (?, ?) AND ${guard}`).bind(now, owner, source, destination, ...args),
    db.prepare(`UPDATE posts SET status = 'draft', scheduled_at = NULL WHERE owner_id = ? AND brand IN (?, ?) AND status = 'scheduled' AND ${guard}`).bind(owner, source, destination, ...args),
    db.prepare(`DELETE FROM instagram_publish_jobs WHERE owner_id = ? AND status IN ('pending','failed') AND post_id IN (SELECT id FROM posts WHERE owner_id = ? AND brand IN (?, ?)) AND ${guard}`).bind(owner, owner, source, destination, ...args),
    db.prepare(`UPDATE instagram_publish_jobs SET facebook_status = 'skipped', facebook_error = 'Conexión de la marca modificada; envío cancelado.', updated_at = ? WHERE owner_id = ? AND facebook_status IN ('pending','failed') AND post_id IN (SELECT id FROM posts WHERE owner_id = ? AND brand IN (?, ?)) AND ${guard}`).bind(now, owner, owner, source, destination, ...args),
    db.prepare(`UPDATE autopilot_slots SET status = 'skipped', claim_id = NULL, last_error = 'Conexión modificada; revisa la programación.', updated_at = ? WHERE owner_id = ? AND brand_id IN (SELECT id FROM brand_registry WHERE owner_id = ? AND name IN (?, ?)) AND status IN ('pending','failed','processing') AND ${guard}`).bind(now, owner, owner, source, destination, ...args),
    ...["facebook_accounts", "facebook_oauth_states", "instagram_oauth_states"].map(table => db.prepare(`DELETE FROM ${table} WHERE owner_id = ? AND brand IN (?, ?) AND ${guard}`).bind(owner, source, destination, ...args)),
    target
      ? db.prepare(`UPDATE instagram_accounts SET brand = ?, updated_at = ? WHERE owner_id = ? AND brand = ? AND username = ? AND ${guard}`).bind(target, now, owner, source, username, ...args)
      : db.prepare(`DELETE FROM instagram_accounts WHERE owner_id = ? AND brand = ? AND username = ? AND ${guard}`).bind(owner, source, username, ...args),
  ];
  const result = await db.batch(statements);
  return result[result.length - 1]?.meta.changes === 1;
}
