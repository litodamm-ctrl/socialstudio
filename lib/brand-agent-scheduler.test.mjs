import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { DatabaseSync } from 'node:sqlite';

const source = (await Promise.all(['brands.ts', 'autopilot.ts', 'brand-agent-scheduler.ts'].map(file => readFile(new URL(file, import.meta.url), 'utf8')))).join('\n').replace(/^import .*;\n/gm, '');
const module = await import('data:text/javascript;base64,' + Buffer.from(stripTypeScriptTypes('let generateCreative; export function setGenerator(value) { generateCreative = value; }\n' + source)).toString('base64'));

async function fixture() {
  const sql = new DatabaseSync(':memory:');
  const db = {
    prepare(query) {
      const statement = sql.prepare(query);
      let args = [];
      return {
        bind(...values) { args = values; return this; },
        async run() { return statement.run(...args); },
        async first() { return statement.get(...args) ?? null; },
        async all() { return { results: statement.all(...args) }; },
      };
    },
    async batch(statements) {
      sql.exec('BEGIN');
      try { const result = []; for (const statement of statements) result.push(await statement.run()); sql.exec('COMMIT'); return result; }
      catch(error) { sql.exec('ROLLBACK'); throw error; }
    },
  };
  await module.ensureBrandRegistry(db);
  await module.ensureAutopilotTables(db);
  sql.exec(`CREATE TABLE posts (id TEXT PRIMARY KEY,owner_id TEXT,brand TEXT,caption TEXT,media_type TEXT,media_url TEXT,scheduled_at TEXT,status TEXT,created_at INTEGER);
    CREATE TABLE instagram_accounts(id TEXT PRIMARY KEY,owner_id TEXT,brand TEXT);
    INSERT INTO brand_registry(id,owner_id,name,brand_essence,auto_schedule,created_at,updated_at) VALUES('brand','owner','Test','Marca de productos auténticos de prueba',1,0,0);
    INSERT INTO instagram_accounts VALUES('account','owner','Test');`);
  let calls = 0;
  const generated = async request => {
    const body = await request.json();
    assert.ok(['Imagen','Historia'].includes(body.mediaType));
    assert.match(body.scheduledDate, /^\d{4}-\d{2}-\d{2}$/);
    calls++;
    return Response.json({ mediaUrl: `/api/media/test-${calls}`, caption: `Creative ${calls}` });
  };
  module.setGenerator(generated);
  const original = Date.now;
  let now = Date.parse('2026-10-02T15:00:00Z');
  Date.now = () => now;
  return {sql, db, generated, calls: () => calls, tick: () => module.processBrandAgentSchedules(db), time: value => {now = Date.parse(value);}, close: () => {Date.now = original; sql.close();}, count: table => sql.prepare(`SELECT count(*) AS n FROM ${table}`).get().n};
}

test('fills 30 feed/story slots once, preserves removed and edited posts, renews continuously two days before end', async () => {
  const f = await fixture();
  try {
    for(let i=0;i<35;i++) await f.tick();
    assert.equal(f.count('autopilot_slots'), 30);
    assert.equal(f.count('posts'),30);
    assert.equal(f.calls(),30);
    assert.equal(f.sql.prepare("SELECT count(*) AS n FROM posts WHERE media_type='Historia'").get().n,15);
    const rows = f.sql.prepare('SELECT * FROM posts ORDER BY scheduled_at').all();
    f.sql.prepare('DELETE FROM posts WHERE id=?').run(rows[0].id);
    f.sql.prepare("UPDATE posts SET caption='Edited by owner',scheduled_at='2026-10-25T15:00:00.000Z' WHERE id=?").run(rows[1].id);
    await f.tick();
    assert.equal(f.count('posts'),29);
    assert.equal(f.calls(),30);
    assert.equal(f.sql.prepare('SELECT caption FROM posts WHERE id=?').get(rows[1].id).caption,'Edited by owner');
    f.time('2026-10-14T15:00:00Z'); await f.tick();
    assert.equal(f.count('autopilot_cycles'),1);
    f.time('2026-10-15T15:00:00Z'); await f.tick();
    assert.equal(f.count('autopilot_cycles'),2);
    assert.equal(f.count('autopilot_slots'),60);
    assert.deepEqual(f.sql.prepare('SELECT start_date,end_date FROM autopilot_cycles ORDER BY start_date').all().map(row=>({...row})), [
      {start_date:'2026-10-03',end_date:'2026-10-17'}, {start_date:'2026-10-18',end_date:'2026-11-01'},
    ]);
  } finally {f.close();}
});

test('pause during generation prevents the post from being scheduled', async () => {
  const f = await fixture();
  try {
    module.setGenerator(async request => { f.sql.exec('UPDATE brand_registry SET auto_schedule=0'); return f.generated(request); });
    await f.tick();
    assert.equal(f.count('posts'),0);
    await f.tick();
    assert.equal(f.calls(),1);
  } finally {f.close();}
});

test('failed generation retries the same slot at most three times', async () => {
  const f = await fixture();
  try {
    let calls=0;
    module.setGenerator(async () => {calls++; return Response.json({error:'provider unavailable'},{status:502});});
    await f.tick();
    const failed=f.sql.prepare("SELECT id FROM autopilot_slots WHERE status='failed'").get();
    f.sql.prepare("UPDATE autopilot_slots SET status='skipped' WHERE id<>?").run(failed.id);
    for(let i=0;i<5;i++) {
      f.sql.prepare('UPDATE autopilot_slots SET updated_at=0 WHERE id=?').run(failed.id);
      await f.tick();
    }
    assert.equal(calls,3);
    assert.equal(f.sql.prepare('SELECT attempts FROM autopilot_slots WHERE id=?').get(failed.id).attempts,3);
    assert.equal(f.count('posts'),0);
  } finally {f.close();}
});

test('automatic brief does not turn project names in brand essence into explicit source selection', async () => {
  const f = await fixture();
  try {
    f.sql.exec("UPDATE brand_registry SET brand_essence='Comercializamos Altorena, Veranorte y Grand Bay en Cartagena.'");
    module.setGenerator(async request => {
      const data = await request.clone().json();
      assert.doesNotMatch(data.brief, /Altorena|Veranorte|Grand Bay/);
      return f.generated(request);
    });
    await f.tick();
    assert.equal(f.calls(),1);
  } finally { f.close(); }
});

test('concurrent ticks share one generation lease', async () => {
  const f = await fixture();
  try {
    let release;
    const waiting=new Promise(resolve=>{release=resolve;});
    let entered;
    const started=new Promise(resolve=>{entered=resolve;});
    module.setGenerator(async request=>{entered(); await waiting; return f.generated(request);});
    const first=f.tick();
    await started;
    await f.tick();
    assert.equal(f.count('posts'),0);
    release(); await first;
    assert.equal(f.calls(),1);
    assert.equal(f.count('posts'),1);
  } finally {f.close();}
});
