import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { analyzeSeo } from './seo-audit.ts';

test('HTML findings distinguish missing alt, decorative images and robots directives', () => {
  const page = analyzeSeo(`<html lang="es"><title>Tortas artesanales en Cartagena | Mi pastelería</title><meta name="viewport" content="width=device-width"><meta content="Una descripción" name="description"><meta name="robots" content="noindex,follow"><link href="https://example.com/" rel="canonical"><h1>Tortas</h1><img src="one"><img alt="" src="decorative"><script type="application/ld+json">{}</script></html>`, 'https://example.com/');
  assert.deepEqual(page.findings.map(f => f.code), ['alt-missing', 'noindex']);
  assert.match(page.findings[0].evidence, /1 de 2/);
  assert.equal(page.score, 70);
  const script = analyzeSeo('<html><script>"<h1>fake</h1><meta name=robots content=noindex>"</script></html>', 'https://example.com/');
  assert.ok(script.findings.some(f => f.code === 'h1-missing'));
  assert.ok(!script.findings.some(f => f.code === 'noindex'));
});

const source = readFileSync(new URL('./seo.ts', import.meta.url), 'utf8');
const dependencies = {
  '@/lib/brands': new URL('./brands.ts', import.meta.url).href,
  '@/lib/website-sources': new URL('./website-sources.ts', import.meta.url).href,
  '@/lib/seo-audit': new URL('./seo-audit.ts', import.meta.url).href,
};
let code = source.replace('import { env } from "@/lib/runtime";', 'const env = {};').replace('import { googleSnapshot } from "@/lib/seo-google";', 'const googleSnapshot = async () => ({errors:["No Google connected"]});');
for (const [alias, url] of Object.entries(dependencies)) code = code.replaceAll(`"${alias}"`, JSON.stringify(url));
const { ensureSeo, seoSettings, brandOwned, queueSeo, runSeo, processSeoSchedules } = await import(`data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(code).replace('await fetchPublicResource(url, MAX_WEBSITE_BYTES)', 'await globalThis.__seoRead(url)')).toString('base64')}`);
function fixture() {
  const sql = new DatabaseSync(':memory:');
  const db = { prepare(query) { let args = []; return { bind(...params) { args = params; return this; }, async run() { const r = sql.prepare(query).run(...args); return { meta: { changes: Number(r.changes) } }; }, async first() { return sql.prepare(query).get(...args) ?? null; }, async all() { return { results: sql.prepare(query).all(...args) }; } }; } };
  return { sql, db };
}
test('SEO isolates owners, prevents overlapping runs, persists failures and releases locks', async () => {
  const { sql, db } = fixture();
  try {
    await ensureSeo(db); await ensureSeo(db);
    sql.exec(`INSERT INTO brand_registry(id,owner_id,name,website_url,created_at,updated_at) VALUES('a','owner','Brand A','https://example.com/',0,0),('b','other','Brand B','https://example.org/',0,0)`);
    assert.equal(await brandOwned(db, 'other', 'a'), null);
    const brand = await brandOwned(db, 'owner', 'a');
    const queued = await queueSeo(db, brand);
    await assert.rejects(queueSeo(db, brand), /proceso/);
    assert.equal(sql.prepare('SELECT count(*) as n FROM seo_runs').get().n, 1);
    // Simulate a brand being archived after queueing: no network requests may run.
    sql.exec("UPDATE brand_registry SET active = 0 WHERE id = 'a'");
    await runSeo(db, queued.id);
    assert.equal(sql.prepare('SELECT status FROM seo_runs').get().status, 'failed');
    assert.equal((await seoSettings(db, 'owner', 'a')).lease_until, 0);
    await runSeo(db, queued.id);
    assert.equal(sql.prepare('SELECT count(*) as n FROM seo_runs').get().n, 1);
    assert.equal(await brandOwned(db, 'other', 'b') !== null, true);
    await processSeoSchedules(db);
    assert.equal(sql.prepare('SELECT count(*) as n FROM seo_runs').get().n, 1);
  } finally { sql.close(); }
});

test('scheduled audits persist evidence once and leave disabled brands alone', async () => {
  const { sql, db } = fixture(); let reads = 0;
  globalThis.__seoRead = async url => { reads++; return { url, contentType: 'text/html', bytes: Buffer.from('<html lang="es"><title>Una marca con título descriptivo</title><h1>Servicios</h1></html>') }; };
  try {
    await ensureSeo(db);
    sql.exec(`INSERT INTO brand_registry(id,owner_id,name,website_url,created_at,updated_at) VALUES('a','owner','Brand A','https://example.com/',0,0),('b','owner','Brand B','https://example.org/',0,0)`);
    await seoSettings(db, 'owner', 'a'); await seoSettings(db, 'owner', 'b');
    sql.exec("UPDATE seo_settings SET enabled = 1, cadence = 'daily' WHERE brand_id = 'a'");
    await processSeoSchedules(db); await processSeoSchedules(db);
    assert.equal(reads, 1);
    const run = sql.prepare('SELECT * FROM seo_runs').get();
    assert.equal(run.brand_id, 'a'); assert.equal(run.status, 'completed');
    const report = JSON.parse(run.report);
    assert.equal(report.pages[0].url, 'https://example.com/');
    assert.ok(report.pages[0].findings.some(f => f.code === 'description-missing'));
    assert.equal(report.agent.text, ''); assert.match(report.agent.status, /OpenAI/);
    await runSeo(db, run.id); assert.equal(reads, 1);
    assert.equal(sql.prepare('SELECT count(*) as n FROM seo_runs').get().n, 1);
  } finally { sql.close(); delete globalThis.__seoRead; }
});
