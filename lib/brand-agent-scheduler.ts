import { POST as generateCreative } from "@/lib/generate-creative";
import { ensureBrandRegistry } from "@/lib/brands";
import { agentSlots } from "@/lib/agent-slots";

type DueBrand = { id: string; owner_id: string; name: string; brand_essence: string; posting_days: string; preferred_time: string };

const RUNS_TABLE_SQL = `CREATE TABLE IF NOT EXISTS brand_agent_runs (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  brand_id TEXT NOT NULL,
  slot TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('processing', 'completed', 'failed')),
  last_error TEXT,
  updated_at INTEGER NOT NULL,
  UNIQUE(owner_id, brand_id, slot)
)`;

export async function processBrandAgentSchedules(db: D1Database) {
  await ensureBrandRegistry(db);
  await db.prepare(RUNS_TABLE_SQL).run();
  const eligible = await db.prepare(`SELECT b.id, b.owner_id, b.name, b.brand_essence, b.posting_days, b.preferred_time
    FROM brand_registry b JOIN instagram_accounts a ON a.owner_id = b.owner_id AND a.brand = b.name
    WHERE b.active = 1 AND b.auto_schedule = 1 AND length(trim(b.brand_essence)) >= 20
    ORDER BY COALESCE((SELECT MAX(r.updated_at) FROM brand_agent_runs r WHERE r.owner_id = b.owner_id AND r.brand_id = b.id), 0)`).all<DueBrand>();

  const now = Date.now();
  const processed: string[] = [];
  let attempted = 0;
  for (const brand of eligible.results ?? []) {
    if (attempted >= 1) break;
    let slotValue: { iso: string; localDate: string } | null = null;
    for (const candidate of agentSlots(now, brand.posting_days, brand.preferred_time)) {
      const start = `${candidate.localDate}T05:00:00.000Z`;
      const end = new Date(Date.parse(start) + 86400_000).toISOString();
      const occupied = await db.prepare("SELECT id FROM posts WHERE owner_id = ? AND brand = ? AND status IN ('scheduled', 'published') AND scheduled_at >= ? AND scheduled_at < ? LIMIT 1")
        .bind(brand.owner_id, brand.name, start, end).first();
      if (occupied) continue;
      const completed = await db.prepare("SELECT id FROM brand_agent_runs WHERE owner_id = ? AND brand_id = ? AND slot = ? AND status = 'completed'")
        .bind(brand.owner_id, brand.id, `${candidate.localDate}T${brand.preferred_time}`).first();
      // A cancelled generated post must not be silently recreated.
      if (completed) continue;
      slotValue = candidate;
      break;
    }
    if (!slotValue) continue;

    const slotStart = new Date(`${slotValue.localDate}T05:00:00.000Z`).toISOString();
    const slotEnd = new Date(new Date(slotStart).getTime() + 24 * 60 * 60_000).toISOString();
    const existingPost = await db.prepare("SELECT id FROM posts WHERE owner_id = ? AND brand = ? AND status = 'scheduled' AND scheduled_at >= ? AND scheduled_at < ? LIMIT 1")
      .bind(brand.owner_id, brand.name, slotStart, slotEnd).first<{ id: string }>();
    if (existingPost) continue;

    const slotKey = `${slotValue.localDate}T${brand.preferred_time}`;
    const claimId = crypto.randomUUID();
    const newJob = await db.prepare("INSERT OR IGNORE INTO brand_agent_runs (id, owner_id, brand_id, slot, status, updated_at) VALUES (?, ?, ?, ?, 'processing', ?)")
      .bind(claimId, brand.owner_id, brand.id, slotKey, now).run();
    if ((newJob.meta.changes ?? 0) === 0) {
      const retried = await db.prepare("UPDATE brand_agent_runs SET id = ?, status = 'processing', last_error = NULL, updated_at = ? WHERE owner_id = ? AND brand_id = ? AND slot = ? AND status IN ('failed', 'processing') AND updated_at < ? RETURNING id")
        .bind(claimId, now, brand.owner_id, brand.id, slotKey, now - 30 * 60_000).first<{ id: string }>();
      if (!retried) continue;
    }

    attempted++;
    try {
      const generated = await generateCreative(new Request("https://social-studio.internal/api/agent/generate", {
        method: "POST",
        headers: { "content-type": "application/json", "oai-authenticated-user-id": brand.owner_id },
        body: JSON.stringify({ brand: brand.name, objective: "Comunidad", brief: brand.brand_essence.slice(0, 600), callToAction: "Invita a conocer más sobre la marca." }),
      }));
      const result = await generated.json() as { error?: string; mediaUrl?: string; caption?: string };
      if (!generated.ok || !result.mediaUrl || !result.caption) throw new Error(result.error ?? "El agente no devolvió contenido completo.");
      const postId = crypto.randomUUID();
      await db.batch([
        db.prepare(`INSERT INTO posts (id, owner_id, brand, caption, media_type, media_url, scheduled_at, status, created_at)
          SELECT ?, ?, ?, ?, 'Imagen', ?, ?, 'scheduled', ?
          WHERE EXISTS (SELECT 1 FROM brand_agent_runs WHERE id = ? AND status = 'processing')
          AND EXISTS (SELECT 1 FROM brand_registry WHERE id = ? AND owner_id = ? AND active = 1 AND auto_schedule = 1)
          AND NOT EXISTS (SELECT 1 FROM posts WHERE owner_id = ? AND brand = ? AND status IN ('scheduled', 'published') AND scheduled_at >= ? AND scheduled_at < ?)`)
          .bind(postId, brand.owner_id, brand.name, result.caption, result.mediaUrl, slotValue.iso, Date.now(), claimId, brand.id, brand.owner_id, brand.owner_id, brand.name, slotStart, slotEnd),
        db.prepare("UPDATE brand_agent_runs SET status = 'completed', last_error = NULL, updated_at = ? WHERE id = ? AND status = 'processing'")
          .bind(Date.now(), claimId),
      ]);
      processed.push(brand.name);
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 300) : "No se pudo generar el contenido.";
      await db.prepare("UPDATE brand_agent_runs SET status = 'failed', last_error = ?, updated_at = ? WHERE id = ? AND status = 'processing'")
        .bind(message, Date.now(), claimId).run();
      console.error("Brand agent scheduling failed", brand.name, message);
    }
  }
  if (processed.length) console.info("Brand agents scheduled content", processed.join(", "));
}
