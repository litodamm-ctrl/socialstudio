export const FACEBOOK_TABLES_SQL = [
  `CREATE TABLE IF NOT EXISTS facebook_oauth_states (
    state TEXT PRIMARY KEY, owner_id TEXT NOT NULL, brand TEXT NOT NULL, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS facebook_accounts (
    id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, brand TEXT NOT NULL, page_id TEXT NOT NULL, page_name TEXT NOT NULL,
    instagram_user_id TEXT NOT NULL, encrypted_page_token TEXT NOT NULL, token_expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(owner_id, brand)
  )`,
];

export async function ensureFacebookTables(db: D1Database) {
  for (const sql of FACEBOOK_TABLES_SQL) await db.prepare(sql).run();
}

