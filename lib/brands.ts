export const DEFAULT_BRANDS = [
  { name: "FITZONE", color: "#c44a6b", handle: "@fitzone_ctg", initials: "FZ" },
  { name: "Bahía Pádel", color: "#217d75", handle: "@bahiapadel", initials: "BP" },
  { name: "D’Neyla", color: "#bd7855", handle: "@dneylacentrohistorico", initials: "D" },
  { name: "Manglar", color: "#68865a", handle: "@manglarartesanias", initials: "M" },
];

export const BRAND_REGISTRY_SQL = `CREATE TABLE IF NOT EXISTS brand_registry (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  name TEXT NOT NULL,
  handle TEXT NOT NULL DEFAULT '',
  color TEXT NOT NULL DEFAULT '#557b66',
  initials TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  brand_essence TEXT NOT NULL DEFAULT '',
  website_url TEXT NOT NULL DEFAULT '',
  website_urls TEXT NOT NULL DEFAULT '[]',
  drive_folder_url TEXT NOT NULL DEFAULT '',
  drive_folder_id TEXT NOT NULL DEFAULT '',
  drive_refresh_token TEXT,
  auto_schedule INTEGER NOT NULL DEFAULT 0,
  auto_crosspost INTEGER NOT NULL DEFAULT 0,
  posting_days TEXT NOT NULL DEFAULT '[0,1,2,3,4,5,6]',
  preferred_time TEXT NOT NULL DEFAULT '18:00',
  story_time TEXT NOT NULL DEFAULT '09:00',
  auto_stories INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(owner_id, name)
)`;

export async function ensureBrandRegistry(db: D1Database) {
  await db.prepare(BRAND_REGISTRY_SQL).run();
  for (const [column, definition] of [["website_urls", "TEXT NOT NULL DEFAULT '[]'"], ["story_time", "TEXT NOT NULL DEFAULT '09:00'"], ["auto_stories", "INTEGER NOT NULL DEFAULT 1"]]) {
    try { await db.prepare(`ALTER TABLE brand_registry ADD COLUMN ${column} ${definition}`).run(); }
    catch (error) { if (!(error instanceof Error) || !/duplicate column name/i.test(error.message)) throw error; }
  }
  try { await db.prepare("ALTER TABLE brand_registry ADD COLUMN auto_crosspost INTEGER NOT NULL DEFAULT 0").run(); }
  catch (error) { if (!(error instanceof Error) || !/duplicate column name/i.test(error.message)) throw error; }
  await db.prepare(`CREATE TABLE IF NOT EXISTS brand_assets (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    brand_id TEXT NOT NULL,
    name TEXT NOT NULL,
    content_type TEXT NOT NULL,
    object_key TEXT NOT NULL,
    file_size INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  )`).run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS brand_drive_states (
    state TEXT PRIMARY KEY, owner_id TEXT NOT NULL, brand_id TEXT NOT NULL, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL
  )`).run();
}

export async function ensureDefaultBrands(db: D1Database, ownerId: string) {
  await ensureBrandRegistry(db);
  const now = Date.now();
  for (const brand of DEFAULT_BRANDS) {
    await db.prepare(
      "INSERT OR IGNORE INTO brand_registry (id, owner_id, name, handle, color, initials, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).bind(crypto.randomUUID(), ownerId, brand.name, brand.handle, brand.color, brand.initials, now, now).run();
  }
}

export async function isActiveBrand(db: D1Database, ownerId: string, name: string) {
  const brand = await db.prepare("SELECT id FROM brand_registry WHERE owner_id = ? AND name = ? AND active = 1")
    .bind(ownerId, name).first<{ id: string }>();
  return Boolean(brand);
}

export function brandInitials(name: string) {
  return name.trim().split(/\s+/).slice(0, 2).map((part) => Array.from(part)[0]?.toUpperCase() ?? "").join("");
}
