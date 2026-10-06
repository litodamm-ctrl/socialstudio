import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { restoreAgentCalendar } from './restore-agent-calendar.ts';
test('restores existing future creative without regenerating or crossing brands; retries only connection cancellations', async () => {
  const sql = new DatabaseSync(':memory:');
  sql.exec(`CREATE TABLE brand_registry(id TEXT,owner_id TEXT,name TEXT,active INTEGER,auto_schedule INTEGER,auto_stories INTEGER);
    INSERT INTO brand_registry VALUES ('b','o','Bahia',1,1,1),('d','o','Dneyla',1,1,1);
    CREATE TABLE instagram_accounts(owner_id TEXT,brand TEXT,username TEXT);
    INSERT INTO instagram_accounts VALUES ('o','Bahia','bahia');
    CREATE TABLE posts(id TEXT,owner_id TEXT,brand TEXT,status TEXT,scheduled_at TEXT,media_url TEXT,media_type TEXT);
    CREATE TABLE instagram_publish_jobs(post_id TEXT);
    CREATE TABLE autopilot_slots(id TEXT,owner_id TEXT,brand_id TEXT,post_id TEXT,status TEXT,scheduled_at TEXT,media_type TEXT,attempts INTEGER,claim_id TEXT,last_error TEXT,updated_at INTEGER);`);
  for (const [id,brand,date] of [['good','Bahia','2026-10-10'],['past','Bahia','2026-10-01'],['foreign','Dneyla','2026-10-10'],['sent','Bahia','2026-10-11']]) {
    sql.prepare("INSERT INTO posts VALUES (?,'o',?,'draft',NULL,'https://example.com/image.jpg','Imagen')").run(id,brand);
    sql.prepare("INSERT INTO autopilot_slots VALUES (?,'o',?,?,'completed',?,'Imagen',1,NULL,NULL,0)").run(id,brand==='Bahia'?'b':'d',id,`${date}T23:00:00.000Z`);
  }
  sql.exec("INSERT INTO instagram_publish_jobs VALUES ('sent')");
  for (const [id,status,error] of [['cancel','skipped','Conexión modificada; revisa la programación.'],['deleted','skipped','Removed'],['failed','failed','Source error'],['deleted-complete','completed',null]]) {
    sql.prepare("INSERT INTO autopilot_slots VALUES (?,'o','b',NULL,?,'2026-10-12T23:00:00.000Z','Historia',3,NULL,?,0)").run(id,status,error);
  }
  const db={prepare(q){let args;return {bind(...v){args=v;return this},async all(){return {results:sql.prepare(q).all(...args)}}}}};
  const now=Date.parse('2026-10-06T16:00:00Z');
  assert.deepEqual(await restoreAgentCalendar(db,'o','b','wrong',now),{restored:0,retried:0});
  assert.deepEqual(await restoreAgentCalendar(db,'o','b','bahia',now),{restored:1,retried:2});
  assert.deepEqual(await restoreAgentCalendar(db,'o','b','bahia',now),{restored:0,retried:0});
  assert.equal(sql.prepare("SELECT scheduled_at FROM posts WHERE id='good'").get().scheduled_at,'2026-10-10T23:00:00.000Z');
  assert.equal(sql.prepare("SELECT COUNT(*) n FROM posts WHERE status='draft'").get().n,3);
  assert.equal(sql.prepare("SELECT status FROM autopilot_slots WHERE id='deleted'").get().status,'skipped');
  assert.equal(sql.prepare("SELECT status FROM autopilot_slots WHERE id='deleted-complete'").get().status,'completed');
  sql.close();
});
