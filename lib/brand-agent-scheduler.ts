import { processCalendarRefresh } from "@/lib/calendar-refresh";
import { POST as generateCreative } from "@/lib/generate-creative";
import { ensureBrandRegistry } from "@/lib/brands";
import { CYCLE_DAYS, addDays, localDate, cycleDates, cycleSlots, ensureAutopilotTables } from "@/lib/autopilot";

type Brand = { id: string; owner_id: string; name: string; brand_essence: string; posting_days: string; preferred_time: string; story_time: string; auto_stories: number };
type Slot = { id: string; brand_id: string; owner_id: string; local_date: string; media_type: string; scheduled_at: string; objective: string; name: string; brand_essence: string };

// One paid creative at a time across invocations. Slots survive crashes and cancellations.
export async function processBrandAgentSchedules(db: D1Database) {
  await ensureBrandRegistry(db);
  await ensureAutopilotTables(db);
  const now = Date.now();
  const claim = crypto.randomUUID();
  await db.prepare("INSERT OR IGNORE INTO autopilot_worker (id, lease_until) VALUES ('generation', 0)").run();
  const lock = await db.prepare("UPDATE autopilot_worker SET claim_id = ?, lease_until = ? WHERE id = 'generation' AND lease_until < ? RETURNING id")
    .bind(claim, now + 12 * 60_000, now).first();
  if (!lock) return;
  try {
    if (await processCalendarRefresh(db, generateCreative, claim)) return;
    const brands = await db.prepare(`SELECT b.* FROM brand_registry b
      JOIN instagram_accounts a ON a.owner_id = b.owner_id AND a.brand = b.name
      WHERE b.active = 1 AND b.auto_schedule = 1 AND length(trim(b.brand_essence)) >= 20`).all<Brand>();
    for (const brand of brands.results ?? []) {
      const latest = await db.prepare("SELECT id, start_date, end_date FROM autopilot_cycles WHERE owner_id = ? AND brand_id = ? ORDER BY start_date DESC LIMIT 1")
        .bind(brand.owner_id, brand.id).first<{id: string; start_date: string; end_date: string}>();
      // Extend an active legacy cycle once, appending only its new dates.
      // Existing posts, skipped slots and user edits remain untouched.
      const extendedEnd = latest && addDays(latest.start_date, CYCLE_DAYS - 1);
      const extend = Boolean(latest && extendedEnd && latest.end_date >= localDate(now) && latest.end_date < extendedEnd);
      const dates = extend && latest && extendedEnd
        ? { start: latest.start_date, end: extendedEnd }
        : cycleDates(now, latest?.end_date);
      if (!dates) continue;
      const cycleId = extend && latest ? latest.id : `${brand.id}:${dates.start}`;
      const slots = cycleSlots(dates.start, brand.posting_days, brand.preferred_time, brand.story_time, Boolean(brand.auto_stories))
        .filter(slot => !extend || !latest || slot.date > latest.end_date);
      await db.batch([
        db.prepare("INSERT OR IGNORE INTO autopilot_cycles (id, owner_id, brand_id, start_date, end_date, created_at) VALUES (?, ?, ?, ?, ?, ?)")
          .bind(cycleId, brand.owner_id, brand.id, dates.start, dates.end, now),
        db.prepare("UPDATE autopilot_cycles SET end_date = ? WHERE id = ? AND owner_id = ? AND brand_id = ? AND end_date < ?")
          .bind(dates.end, cycleId, brand.owner_id, brand.id, dates.end),
        ...slots.map(slot => db.prepare(`INSERT OR IGNORE INTO autopilot_slots
          (id, cycle_id, owner_id, brand_id, local_date, media_type, scheduled_at, objective, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .bind(crypto.randomUUID(), cycleId, brand.owner_id, brand.id, slot.date, slot.mediaType, slot.scheduledAt, slot.objective, now)),
      ]);
    }
    const publicationCutoff = new Date(now + 15 * 60_000).toISOString();
    await db.prepare("UPDATE autopilot_slots SET status = 'skipped', last_error = 'Fecha vencida; no se publicará contenido atrasado.', updated_at = ? WHERE status IN ('pending', 'failed', 'processing') AND scheduled_at <= ?")
      .bind(now, publicationCutoff).run();
    // One-time recovery for future slots that failed before the Instagram-style fallback fix.
    // Updating updated_at makes this idempotent: recovered rows no longer match the recovery cutoff.
    await db.prepare(`UPDATE autopilot_slots
      SET status = 'pending', attempts = 0, claim_id = NULL, last_error = NULL, updated_at = ?
      WHERE status = 'failed' AND post_id IS NULL AND scheduled_at > ? AND updated_at < ?`)
      .bind(now, publicationCutoff, Date.parse("2026-11-10T06:17:40.000Z")).run();
    const due = await db.prepare(`SELECT s.*, b.name, b.brand_essence FROM autopilot_slots s
      JOIN brand_registry b ON b.id = s.brand_id AND b.owner_id = s.owner_id
      JOIN instagram_accounts a ON a.owner_id = b.owner_id AND a.brand = b.name
      WHERE b.active = 1 AND b.auto_schedule = 1 AND s.attempts < 4
      AND (s.status = 'pending' OR (s.status IN ('failed','processing') AND s.updated_at < ?))
      AND (s.media_type <> 'Historia' OR b.auto_stories = 1)
      ORDER BY s.local_date, s.attempts, COALESCE((SELECT MAX(t.updated_at) FROM autopilot_slots t WHERE t.brand_id = b.id AND t.attempts > 0),0), s.scheduled_at LIMIT 1`)
      .bind(now - 60_000).first<Slot>();
    if (!due) {
      const summary = await db.prepare(`SELECT status, COUNT(*) AS total FROM autopilot_slots GROUP BY status ORDER BY status`).all<{status:string;total:number}>();
      console.info("Social Studio autopilot idle", JSON.stringify(summary.results ?? []));
      return;
    }
    const start = `${due.local_date}T05:00:00.000Z`;
    const end = new Date(Date.parse(start) + 86_400_000).toISOString();
    const occupied = await db.prepare(`SELECT id FROM posts WHERE owner_id = ? AND brand = ? AND status IN ('scheduled','published')
      AND scheduled_at >= ? AND scheduled_at < ? AND (CASE WHEN media_type = 'Historia' THEN 'Historia' ELSE 'Imagen' END) = ? LIMIT 1`)
      .bind(due.owner_id, due.name, start, end, due.media_type).first();
    const hasLegacy = due.media_type === "Imagen" && await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'brand_agent_runs'").first();
    const legacyCompleted = hasLegacy && await db.prepare("SELECT id FROM brand_agent_runs WHERE owner_id = ? AND brand_id = ? AND substr(slot,1,10) = ? AND status = 'completed' LIMIT 1")
      .bind(due.owner_id, due.brand_id, due.local_date).first();
    if (occupied || legacyCompleted) {
      await db.prepare("UPDATE autopilot_slots SET status = 'skipped', last_error = 'Ya existe contenido para este formato y día.', updated_at = ? WHERE id = ?")
        .bind(now, due.id).run();
      return;
    }
    const reserved = await db.prepare("UPDATE autopilot_slots SET status = 'processing', claim_id = ?, attempts = attempts + 1, updated_at = ?, last_error = NULL WHERE id = ? AND status IN ('pending','failed','processing') RETURNING id")
      .bind(claim, now, due.id).first();
    if (!reserved) return;
    try {
      const generated = await generateCreative(new Request("https://social-studio.internal/api/agent/generate", {
        method: "POST", headers: { "content-type": "application/json", "oai-authenticated-user-id": due.owner_id },
        body: JSON.stringify({ brand: due.name, objective: due.objective, mediaType: due.media_type, scheduledDate: due.local_date,
          // The generator reads the full essence separately. Including project names here
          // incorrectly turns general brand context into an explicit project selection.
          brief: `Contenido de ${due.media_type === 'Historia' ? 'historia' : 'feed'} para ${due.local_date}. Objetivo ${due.objective}. Usa la información vigente de esta marca y evita repetir temas recientes.`,
          callToAction: "Propón una invitación coherente con la marca sin inventar ofertas ni datos." }),
      }));
      const result = await generated.json() as { error?: string; mediaUrl?: string; caption?: string };
      if (!generated.ok || !result.mediaUrl || !result.caption) throw new Error(result.error ?? "El agente no devolvió contenido completo.");
      const postId = crypto.randomUUID();
      await db.batch([
        db.prepare(`INSERT INTO posts (id, owner_id, brand, caption, media_type, media_url, scheduled_at, status, created_at)
          SELECT ?, ?, ?, ?, ?, ?, ?, 'scheduled', ?
          WHERE EXISTS (SELECT 1 FROM autopilot_slots WHERE id = ? AND claim_id = ? AND status = 'processing')
          AND EXISTS (SELECT 1 FROM autopilot_worker WHERE id = 'generation' AND claim_id = ?)
          AND EXISTS (SELECT 1 FROM brand_registry WHERE id = ? AND active = 1 AND auto_schedule = 1 AND (? <> 'Historia' OR auto_stories = 1))
          AND NOT EXISTS (SELECT 1 FROM posts WHERE owner_id = ? AND brand = ? AND status IN ('scheduled','published') AND scheduled_at >= ? AND scheduled_at < ? AND (CASE WHEN media_type = 'Historia' THEN 'Historia' ELSE 'Imagen' END) = ?)`)
          .bind(postId, due.owner_id, due.name, result.caption, due.media_type, result.mediaUrl, due.scheduled_at, Date.now(), due.id, claim, claim, due.brand_id, due.media_type, due.owner_id, due.name, start, end, due.media_type),
        db.prepare(`UPDATE autopilot_slots SET status = CASE WHEN EXISTS (SELECT 1 FROM posts WHERE id = ?) THEN 'completed' ELSE 'pending' END,
          post_id = CASE WHEN EXISTS (SELECT 1 FROM posts WHERE id = ?) THEN ? ELSE NULL END, updated_at = ?
          WHERE id = ? AND claim_id = ? AND status = 'processing'`)
          .bind(postId, postId, postId, Date.now(), due.id, claim),
      ]);
      const created = await db.prepare("SELECT id FROM posts WHERE id = ?").bind(postId).first<{id:string}>();
      console.info(created ? "Social Studio autopilot generated" : "Social Studio autopilot insert skipped", due.name, due.media_type, due.local_date, postId);
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0,300) : "No se pudo generar el contenido.";
      console.error("Social Studio autopilot generation failed", due.name, due.media_type, due.local_date, message);
      await db.prepare("UPDATE autopilot_slots SET status = 'failed', last_error = ?, updated_at = ? WHERE id = ? AND claim_id = ? AND status = 'processing'")
        .bind(message, Date.now(), due.id, claim).run();
    }
  } finally {
    await db.prepare("UPDATE autopilot_worker SET lease_until = 0 WHERE id = 'generation' AND claim_id = ?").bind(claim).run();
  }
}
