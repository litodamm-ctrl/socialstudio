const DAY = 86_400_000;
export const CYCLE_DAYS = 15;
export function localDate(now: number) { return new Date(now - 5 * 3_600_000).toISOString().slice(0, 10); }
export function addDays(date: string, days: number) { return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10); }
export function cycleDates(now: number, previousEnd?: string): { start: string; end: string } | null {
  const today = localDate(now);
  if (previousEnd && today < addDays(previousEnd, -2)) return null;
  const start = previousEnd && previousEnd >= today ? addDays(previousEnd, 1) : addDays(today, 1);
  return { start, end: addDays(start, CYCLE_DAYS - 1) };
}
export function cycleSlots(start: string, postingDays: string, feedTime: string, storyTime: string, stories: boolean) {
  let days: unknown;
  try { days = JSON.parse(postingDays); } catch { return []; }
  if (!Array.isArray(days) || ![feedTime, storyTime].every(t => /^([01]\d|2[0-3]):[0-5]\d$/.test(t))) return [];
  const slots: Array<{date: string; mediaType: "Imagen" | "Historia"; scheduledAt: string; objective: string}> = [];
  const objectives = ["Reconocimiento", "Educación", "Comunidad", "Ventas"];
  for (let offset = 0; offset < CYCLE_DAYS; offset++) {
    const date = addDays(start, offset);
    const epoch = Date.parse(`${date}T00:00:00Z`);
    if (!days.includes(new Date(epoch).getUTCDay())) continue;
    for (const mediaType of (stories ? ["Historia", "Imagen"] : ["Imagen"]) as Array<"Imagen" | "Historia">) {
      const time = mediaType === "Historia" ? storyTime : feedTime;
      slots.push({date, mediaType, scheduledAt: new Date(`${date}T${time}:00-05:00`).toISOString(), objective: objectives[(Math.floor(epoch / DAY) + (mediaType === "Historia" ? 1 : 0)) % objectives.length]});
    }
  }
  return slots.sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt));
}
export async function ensureAutopilotTables(db: D1Database) {
  await db.prepare(`CREATE TABLE IF NOT EXISTS autopilot_cycles (
    id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, brand_id TEXT NOT NULL,
    start_date TEXT NOT NULL, end_date TEXT NOT NULL, created_at INTEGER NOT NULL,
    UNIQUE(owner_id, brand_id, start_date)
  )`).run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS autopilot_slots (
    id TEXT PRIMARY KEY, cycle_id TEXT NOT NULL, owner_id TEXT NOT NULL, brand_id TEXT NOT NULL,
    local_date TEXT NOT NULL, media_type TEXT NOT NULL, scheduled_at TEXT NOT NULL, objective TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
    claim_id TEXT, post_id TEXT, last_error TEXT, updated_at INTEGER NOT NULL,
    UNIQUE(owner_id, brand_id, local_date, media_type)
  )`).run();
  await db.prepare("CREATE INDEX IF NOT EXISTS autopilot_post_idx ON autopilot_slots(post_id)").run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS autopilot_worker (
    id TEXT PRIMARY KEY, claim_id TEXT, lease_until INTEGER NOT NULL DEFAULT 0
  )`).run();
}
