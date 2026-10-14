import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {ensureCalendarRefresh,queueCalendarRefresh,processCalendarRefresh} from './calendar-refresh.ts';
function fixture() {
 const sql=new DatabaseSync(':memory:');
 sql.exec(`CREATE TABLE posts(id TEXT PRIMARY KEY,owner_id TEXT,brand TEXT,caption TEXT,media_type TEXT,media_url TEXT,scheduled_at TEXT,status TEXT);
 CREATE TABLE brand_registry(id TEXT,owner_id TEXT,active INTEGER);
 CREATE TABLE instagram_publish_jobs(post_id TEXT,owner_id TEXT,status TEXT,container_id TEXT);
 INSERT INTO brand_registry VALUES('brand','owner',1);`);
 const db={prepare(q){let args=[];return{bind(...v){args=v;return this},async run(){const r=sql.prepare(q).run(...args);return{meta:{changes:Number(r.changes)}}},async first(){return sql.prepare(q).get(...args)??null},async all(){return{results:sql.prepare(q).all(...args)}}}},async batch(stmts){sql.exec('BEGIN');try{const r=[];for(const s of stmts)r.push(await s.run());sql.exec('COMMIT');return r}catch(e){sql.exec('ROLLBACK');throw e}}};
 const p={id:'p',owner_id:'owner',brand:'Manglar',caption:'Original',media_type:'Imagen',media_url:'/old',scheduled_at:'2027-01-01T23:00:00.000Z',status:'scheduled'};
 sql.prepare('INSERT INTO posts VALUES(?,?,?,?,?,?,?,?)').run(...Object.values(p));
 return {sql,db,p,close:()=>sql.close()};
}
test('renews in place, keeps date, holds old photo and preserves backup; repeating queue cannot regenerate again',async()=>{
 const f=fixture();try{
 assert.equal(await queueCalendarRefresh(f.db,'owner','brand',[f.p]),1);
 assert.equal(f.sql.prepare('SELECT status FROM posts').get().status,'draft');
 assert.equal(await queueCalendarRefresh(f.db,'owner','brand',[f.p]),0);
 await processCalendarRefresh(f.db,async()=>Response.json({mediaUrl:'/new',caption:'New'}),'claim');
 assert.deepEqual({...f.sql.prepare('SELECT media_url,caption,status,scheduled_at FROM posts').get()},{media_url:'/new',caption:'New',status:'scheduled',scheduled_at:f.p.scheduled_at});
 assert.equal(f.sql.prepare('SELECT original_media FROM calendar_refresh').get().original_media,'/old');
 assert.equal(await processCalendarRefresh(f.db,async()=>{throw new Error('must not run')},'claim'),false);
 }finally{f.close()}
});
test('owner boundaries and publishing jobs are protected',async()=>{
 const f=fixture();try{
 assert.equal(await queueCalendarRefresh(f.db,'another','brand',[f.p]),0);
 f.sql.exec("INSERT INTO instagram_publish_jobs VALUES('p','owner','processing',NULL)");
 assert.equal(await queueCalendarRefresh(f.db,'owner','brand',[f.p]),0);
 assert.equal(f.sql.prepare('SELECT status FROM posts').get().status,'scheduled');
 }finally{f.close()}
});
test('an edit during generation wins and failed generation leaves old creative held',async()=>{
 const f=fixture();try{
 await queueCalendarRefresh(f.db,'owner','brand',[f.p]);
 await processCalendarRefresh(f.db,async()=>{f.sql.exec("UPDATE posts SET caption='User edit'");return Response.json({mediaUrl:'/new',caption:'New'})},'claim');
 assert.equal(f.sql.prepare('SELECT caption FROM posts').get().caption,'User edit');
 assert.equal(f.sql.prepare('SELECT status FROM calendar_refresh').get().status,'skipped');
 }finally{f.close()}
 const g=fixture();try{
 await queueCalendarRefresh(g.db,'owner','brand',[g.p]);
 await processCalendarRefresh(g.db,async()=>Response.json({error:'Provider failed'},{status:502}),'claim');
 assert.equal(g.sql.prepare('SELECT status FROM posts').get().status,'draft');
 assert.equal(g.sql.prepare('SELECT status FROM calendar_refresh').get().status,'failed');
 }finally{g.close()}
});
test('expired date cannot be regenerated or sent late',async()=>{
 const f=fixture();try{
 await ensureCalendarRefresh(f.db);await queueCalendarRefresh(f.db,'owner','brand',[f.p]);
 await processCalendarRefresh(f.db,async()=>{throw new Error('must not generate')},'claim',Date.parse('2027-01-02T00:00:00Z'));
 assert.equal(f.sql.prepare('SELECT status FROM calendar_refresh').get().status,'skipped');
 assert.equal(f.sql.prepare('SELECT status FROM posts').get().status,'draft');
 }finally{f.close()}
});
