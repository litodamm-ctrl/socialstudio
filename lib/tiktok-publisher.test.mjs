import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {stripTypeScriptTypes} from 'node:module';
import {readFile} from 'node:fs/promises';
const sources=(await Promise.all(['tiktok-policy.ts','tiktok.ts','tiktok-publisher.ts'].map(f=>readFile(new URL(f,import.meta.url),'utf8')))).join('\n').replace(/^import .*;\n/gm,'');
const prefix=`const env={BUCKET:{async head(){return {customMetadata:{ownerId:'owner'}}}}};const decryptInstagramToken=async()=> 'test-access';const encryptInstagramToken=async v=>v;`;
const mod=await import('data:text/javascript;base64,'+Buffer.from(stripTypeScriptTypes(prefix+sources)).toString('base64'));
async function fixture(){
 const sql=new DatabaseSync(':memory:');
 const db={prepare(q){let args=[];return{bind(...v){args=v;return this},async run(){const r=sql.prepare(q).run(...args);return{meta:{changes:Number(r.changes)}}},async first(){return sql.prepare(q).get(...args)??null},async all(){return{results:sql.prepare(q).all(...args)}}}},async batch(stmts){sql.exec('BEGIN');try{const result=[];for(const s of stmts)result.push(await s.run());sql.exec('COMMIT');return result}catch(e){sql.exec('ROLLBACK');throw e}}};
 await mod.ensureTikTok(db);
 sql.exec(`CREATE TABLE posts(id TEXT,owner_id TEXT,brand TEXT,media_url TEXT,media_type TEXT);CREATE TABLE brand_registry(id TEXT,owner_id TEXT,name TEXT,active INTEGER);
 INSERT INTO brand_registry VALUES('b','owner','Manglar',1);INSERT INTO posts VALUES('p','owner','Manglar','/api/media/11111111-1111-1111-1111-111111111111','Imagen');`);
 sql.prepare('INSERT INTO tiktok_accounts(id,owner_id,brand_id,open_id,nickname,encrypted_access,encrypted_refresh,access_expires,refresh_expires,scopes,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run('a','owner','b','open','Manglar TikTok','encrypted','refresh',Date.now()+86400_000,Date.now()+365*86400_000,'video.publish',Date.now());
 const options={title:'Nueva pieza',description:'Producto real',privacy:'SELF_ONLY',allowComments:false,commercial:false,ownBrand:false,paidPartnership:false,consent:true,scheduledAt:new Date(Date.now()-1000).toISOString()};
 sql.prepare('INSERT INTO tiktok_jobs(id,owner_id,brand_id,post_id,account_id,open_id,nickname,media_url,options,is_aigc,scheduled_at,media_token,media_expires,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run('j','owner','b','p','a','open','Manglar TikTok','/api/media/11111111-1111-1111-1111-111111111111',JSON.stringify(options),1,options.scheduledAt,'x'.repeat(64),Date.now()+86400_000,Date.now(),Date.now());
 const oldFetch=globalThis.fetch;const oldEnv={...process.env};process.env.TIKTOK_CLIENT_KEY='test';process.env.TIKTOK_CLIENT_SECRET='test';process.env.TIKTOK_MEDIA_DOMAIN_VERIFIED='true';process.env.TIKTOK_DIRECT_POST_APPROVED='false';process.env.SITE_ORIGIN='https://example.com';
 let initiations=0;let init=async()=>({data:{publish_id:'pub-1'},error:{code:'ok'}});
 globalThis.fetch=async(url,config)=>{
  if(String(url).endsWith('creator_info/query/'))return Response.json({data:{privacy_level_options:['SELF_ONLY'],comment_disabled:false},error:{code:'ok'}});
  if(String(url).endsWith('content/init/')){initiations++;const payload=JSON.parse(config.body);assert.equal(payload.is_aigc,true);assert.equal(payload.post_info.privacy_level,'SELF_ONLY');return Response.json(await init());}
  if(String(url).endsWith('status/fetch/'))return Response.json({data:{status:'PUBLISH_COMPLETE'},error:{code:'ok'}});
  throw new Error('Unexpected network request');
 };
 return {sql,db,initiations:()=>initiations,setInit:value=>init=value,tick:()=>mod.processDueTikTokPublications(db),close(){globalThis.fetch=oldFetch;for(const key of ['TIKTOK_CLIENT_KEY','TIKTOK_CLIENT_SECRET','TIKTOK_MEDIA_DOMAIN_VERIFIED','TIKTOK_DIRECT_POST_APPROVED','SITE_ORIGIN']){if(oldEnv[key]===undefined)delete process.env[key];else process.env[key]=oldEnv[key];}sql.close();}};
}
test('concurrent cron invocations initiate once, confirm published status, and never resubmit',async()=>{
 const f=await fixture();try{
  let entered;const started=new Promise(r=>entered=r);let release;const held=new Promise(r=>release=r);
  f.setInit(async()=>{entered();await held;return{data:{publish_id:'pub-1'},error:{code:'ok'}}});
  const first=f.tick();await started;await f.tick();assert.equal(f.initiations(),1);release();await first;
  assert.equal(f.sql.prepare('SELECT status FROM tiktok_jobs').get().status,'published');await f.tick();assert.equal(f.initiations(),1);
 }finally{f.close()}
});
test('network ambiguity stops retries; explicit TikTok rejection is reported as failed',async()=>{
 const f=await fixture();try{
  f.setInit(async()=>{throw new Error('connection lost after send')});await f.tick();await f.tick();
  assert.equal(f.initiations(),1);assert.equal(f.sql.prepare('SELECT status FROM tiktok_jobs').get().status,'uncertain');
 }finally{f.close()}
 const g=await fixture();try{
  g.setInit(async()=>({error:{code:'url_ownership_unverified'}}));await g.tick();assert.equal(g.sql.prepare('SELECT status FROM tiktok_jobs').get().status,'failed');
 }finally{g.close()}
});
test('cancelled jobs, disabled accounts and changed photos cannot publish',async()=>{
 for(const mutation of ["UPDATE tiktok_jobs SET status='cancelled'","UPDATE tiktok_accounts SET active=0","UPDATE posts SET media_url='/another-photo'"]){
  const f=await fixture();try{f.sql.exec(mutation);await f.tick();assert.equal(f.initiations(),0);}finally{f.close()}
 }
});
