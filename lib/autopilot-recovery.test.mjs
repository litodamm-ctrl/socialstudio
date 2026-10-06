import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { retryFailedSlots } from './autopilot-recovery.ts';

test('recovers only future failed slots owned by the active brand and is idempotent', async () => {
  const sql = new DatabaseSync(':memory:');
  sql.exec(`CREATE TABLE brand_registry(id TEXT, owner_id TEXT, active INTEGER, auto_schedule INTEGER, auto_stories INTEGER);
    INSERT INTO brand_registry VALUES ('brand','owner',1,1,1), ('other','owner',1,1,1);
    CREATE TABLE autopilot_slots(id TEXT,owner_id TEXT,brand_id TEXT,status TEXT,post_id TEXT,scheduled_at TEXT,media_type TEXT,attempts INTEGER,claim_id TEXT,last_error TEXT,updated_at INTEGER);`);
  const insert = sql.prepare('INSERT INTO autopilot_slots VALUES (?,?,?,?,?,?,?,3,NULL,?,0)');
  for (const [id,status,date,post,owner,brand] of [
    ['retry','failed','2026-10-10',null,'owner','brand'],
    ['done','completed','2026-10-10',null,'owner','brand'],
    ['deleted','skipped','2026-10-10',null,'owner','brand'],
    ['busy','processing','2026-10-10',null,'owner','brand'],
    ['past','failed','2026-10-01',null,'owner','brand'],
    ['post','failed','2026-10-10','existing','owner','brand'],
    ['foreign','failed','2026-10-10',null,'someone','brand'],
    ['otherbrand','failed','2026-10-10',null,'owner','other'],
  ]) insert.run(id,owner,brand,status,post,`${date}T15:00:00.000Z`,'Imagen','source unavailable');
  const db = { prepare(query) { let args; return { bind(...values) { args=values; return this; }, async all() { return {results:sql.prepare(query).all(...args)}; } }; } };
  const now = Date.parse('2026-10-06T15:00:00.000Z');
  assert.equal(await retryFailedSlots(db,'owner','brand',now),1);
  assert.equal(await retryFailedSlots(db,'owner','brand',now),0);
  assert.equal(sql.prepare("SELECT attempts FROM autopilot_slots WHERE id='retry'").get().attempts,0);
  assert.equal(sql.prepare('SELECT COUNT(*) n FROM autopilot_slots WHERE attempts=3').get().n,7);
  sql.exec("UPDATE autopilot_slots SET status='failed' WHERE id='retry'; UPDATE brand_registry SET auto_schedule=0 WHERE id='brand'");
  assert.equal(await retryFailedSlots(db,'owner','brand',now),0);
  sql.close();
});
