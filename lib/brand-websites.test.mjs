import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { ensureBrandRegistry } from './brands.ts';

test('website migration preserves legacy brand data and can run twice', async () => {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`CREATE TABLE brand_registry (id TEXT PRIMARY KEY, website_url TEXT);
    INSERT INTO brand_registry VALUES ('existing', 'https://example.com/project');`);
  const db = { prepare(sql) { return { async run() { return sqlite.prepare(sql).run(); } }; } };
  await ensureBrandRegistry(db);
  await ensureBrandRegistry(db);
  const row = sqlite.prepare('SELECT website_url, website_urls FROM brand_registry').get();
  assert.equal(row.website_url, 'https://example.com/project');
  assert.equal(row.website_urls, '[]');
  sqlite.close();
});
