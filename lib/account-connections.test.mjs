import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { changeInstagramConnection } from './account-connections.ts';

function fixture() {
  const sql = new DatabaseSync(':memory:');
  sql.exec(`CREATE TABLE brand_registry(id TEXT, owner_id TEXT, name TEXT, active INTEGER, auto_schedule INTEGER, auto_crosspost INTEGER, updated_at INTEGER);
    INSERT INTO brand_registry VALUES('b','owner','Bahía',1,1,1,0),('m','owner','Manglar',1,1,1,0),('d','owner','Dneyla',1,1,1,0);
    CREATE TABLE instagram_accounts(owner_id TEXT,brand TEXT,username TEXT,updated_at INTEGER, UNIQUE(owner_id,brand));
    INSERT INTO instagram_accounts VALUES('owner','Bahía','manglar_colombia',0),('owner','Dneyla','dneyla',0);
    CREATE TABLE posts(id TEXT,owner_id TEXT,brand TEXT,status TEXT,scheduled_at TEXT);
    INSERT INTO posts VALUES('queued','owner','Bahía','scheduled','future'),('published','owner','Bahía','published','past'),('other','owner','Dneyla','scheduled','future');
    CREATE TABLE instagram_publish_jobs(post_id TEXT,owner_id TEXT,status TEXT,facebook_status TEXT,facebook_error TEXT,updated_at INTEGER);
    INSERT INTO instagram_publish_jobs VALUES('queued','owner','pending','pending',NULL,0),('published','owner','published','pending',NULL,0);
    CREATE TABLE autopilot_slots(owner_id TEXT,brand_id TEXT,status TEXT,claim_id TEXT,last_error TEXT,updated_at INTEGER);
    INSERT INTO autopilot_slots VALUES('owner','b','processing','old',NULL,0),('owner','b','completed',NULL,NULL,0);
    CREATE TABLE facebook_accounts(owner_id TEXT,brand TEXT);
    INSERT INTO facebook_accounts VALUES('owner','Bahía'),('owner','Dneyla');
    CREATE TABLE facebook_oauth_states(owner_id TEXT,brand TEXT);
    CREATE TABLE instagram_oauth_states(owner_id TEXT,brand TEXT);
    INSERT INTO instagram_oauth_states VALUES('owner','Bahía');`);
  const db = {
    prepare(query) { let args=[]; return { bind(...values) {args=values;return this;}, async run() {return {meta:{changes:sql.prepare(query).run(...args).changes}};} }; },
    async batch(statements) {sql.exec('BEGIN');try {const result=[];for(const s of statements) result.push(await s.run());sql.exec('COMMIT');return result;}catch(e){sql.exec('ROLLBACK');throw e;}}
  };
  return {sql,db};
}
test('move preserves brand content and published history while pausing unsafe queues', async () => {
  const {sql,db}=fixture();
  try {
    assert.equal(await changeInstagramConnection(db,'owner','Bahía','manglar_colombia','Manglar'),true);
    assert.equal(sql.prepare("SELECT brand FROM instagram_accounts WHERE username='manglar_colombia'").get().brand,'Manglar');
    assert.deepEqual({...sql.prepare("SELECT brand,status,scheduled_at FROM posts WHERE id='queued'").get()}, {brand:'Bahía',status:'draft',scheduled_at:null});
    assert.equal(sql.prepare("SELECT status FROM posts WHERE id='published'").get().status,'published');
    assert.equal(sql.prepare("SELECT status FROM posts WHERE id='other'").get().status,'scheduled');
    assert.equal(sql.prepare("SELECT facebook_status FROM instagram_publish_jobs WHERE post_id='published'").get().facebook_status,'skipped');
    assert.equal(sql.prepare("SELECT count(*) n FROM instagram_oauth_states").get().n,0);
    assert.equal(sql.prepare("SELECT auto_schedule FROM brand_registry WHERE name='Manglar'").get().auto_schedule,0);
    assert.equal(sql.prepare("SELECT count(*) n FROM autopilot_slots WHERE status='completed'").get().n,1);
  } finally {sql.close();}
});
test('disconnect removes only the selected connection and leaves contents as drafts', async () => {
  const {sql,db}=fixture();
  try {
    assert.equal(await changeInstagramConnection(db,'owner','Bahía','manglar_colombia'),true);
    assert.equal(sql.prepare("SELECT count(*) n FROM instagram_accounts").get().n,1);
    assert.equal(sql.prepare("SELECT status FROM posts WHERE id='queued'").get().status,'draft');
    assert.equal(sql.prepare("SELECT auto_schedule FROM brand_registry WHERE name='Manglar'").get().auto_schedule,1);
  } finally {sql.close();}
});
test('in-flight, occupied destination, stale username and foreign owner leave all state untouched', async () => {
  for (const scenario of ['inflight','occupied','stale','foreign']) {
    const {sql,db}=fixture();
    try {
      if(scenario==='inflight') sql.exec("UPDATE instagram_publish_jobs SET status='processing' WHERE post_id='queued'");
      assert.equal(await changeInstagramConnection(db,scenario==='foreign'?'stranger':'owner','Bahía',scenario==='stale'?'different':'manglar_colombia',scenario==='occupied'?'Dneyla':'Manglar'),false);
      assert.equal(sql.prepare("SELECT auto_schedule FROM brand_registry WHERE name='Bahía'").get().auto_schedule,1);
      assert.equal(sql.prepare("SELECT status FROM posts WHERE id='queued'").get().status,'scheduled');
      assert.equal(sql.prepare("SELECT brand FROM instagram_accounts WHERE username='manglar_colombia'").get().brand,'Bahía');
    } finally {sql.close();}
  }
});
