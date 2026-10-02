import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {stripTypeScriptTypes} from 'node:module';
import {DatabaseSync} from 'node:sqlite';

const publisher=await readFile(new URL('./instagram-publisher.ts',import.meta.url),'utf8');
const table=publisher.slice(publisher.indexOf('const JOB_TABLE_SQL'),publisher.indexOf('type PublisherBindings'));
const ensure=publisher.slice(publisher.indexOf('async function ensureJobTable'),publisher.indexOf('async function graphJson'));
const route=(await readFile(new URL('../app/api/posts/[id]/route.ts',import.meta.url),'utf8')).replace(/^import .*;\n/gm,'');
const source=`let env; export function setEnvironment(value){env=value;}\n${table}\n${ensure}\nasync function ensureInstagramPublishJobs(db){await ensureJobTable(db);}\n${route}`;
const module=await import('data:text/javascript;base64,'+Buffer.from(stripTypeScriptTypes(source)).toString('base64'));
const id='11111111-1111-4111-8111-111111111111';
const media='/api/media/22222222-2222-4222-8222-222222222222';
const future='2099-10-02T18:00:00.000Z';
function fixture(){
  const sql=new DatabaseSync(':memory:');
  let hook=()=>{};
  const db={prepare(query){const statement=sql.prepare(query);let args=[];return {bind(...values){args=values;return this;},async run(){const result=statement.run(...args);return {meta:{changes:result.changes}};},async first(){return statement.get(...args)??null;},async all(){return {results:statement.all(...args)};}};},async batch(statements){sql.exec('BEGIN');try{const result=[];for(const statement of statements) result.push(await statement.run());sql.exec('COMMIT');return result;}catch(error){sql.exec('ROLLBACK');throw error;}}};
  sql.exec('CREATE TABLE posts(id TEXT PRIMARY KEY,owner_id TEXT,brand TEXT,caption TEXT,media_type TEXT,media_url TEXT,scheduled_at TEXT,status TEXT,created_at INTEGER)');
  sql.prepare('INSERT INTO posts VALUES(?,?,?,?,?,?,?,?,?)').run(id,'owner','Test','Original','Imagen',media,future,'scheduled',Date.now());
  module.setEnvironment({DB:db,BUCKET:{async head(){hook();return {customMetadata:{ownerId:'owner'},httpMetadata:{contentType:'image/jpeg'}};}}});
  return {sql,hook:value=>{hook=value;},async patch(body={},owner='owner'){return module.PATCH(new Request('https://test/api/posts/'+id,{method:'PATCH',headers:{'content-type':'application/json',...(owner?{'oai-authenticated-user-id':owner}:{})},body:JSON.stringify(body)}),{params:Promise.resolve({id})});},job(status){sql.prepare('INSERT OR REPLACE INTO instagram_publish_jobs(post_id,owner_id,status,updated_at) VALUES(?,?,?,?)').run(id,'owner',status,Date.now());},post:()=>sql.prepare('SELECT * FROM posts WHERE id=?').get(id),close:()=>sql.close()};
}
test('editing requires owner identity and does not expose another owner post',async()=>{
  const f=fixture();try{
    assert.equal((await f.patch({caption:'other'},'')).status,401);
    assert.equal((await f.patch({caption:'other'},'someone-else')).status,404);
    assert.equal(f.post().caption,'Original');
  }finally{f.close();}
});
test('future JPG edit returns updated post and can switch between draft and scheduled',async()=>{
  const f=fixture();try{
    const response=await f.patch({caption:'Updated',mediaUrl:media,status:'scheduled',scheduledAt:future});
    assert.equal(response.status,200);
    const {post}=await response.json();assert.equal(post.caption,'Updated');assert.equal(post.mediaUrl,media);assert.equal(post.scheduledAt,future);
    assert.equal((await f.patch({status:'draft'})).status,200);assert.equal(f.post().scheduled_at,null);assert.equal(f.post().status,'draft');
    assert.equal((await f.patch({status:'scheduled',scheduledAt:future})).status,200);assert.equal(f.post().status,'scheduled');
    assert.equal((await f.patch({status:'scheduled',scheduledAt:'2000-01-01'})).status,400);
    assert.equal((await f.patch({status:'scheduled',mediaUrl:''})).status,400);
  }finally{f.close();}
});
test('processing and published jobs prevent modifications',async()=>{
  const f=fixture();try{
    await f.patch({}); // creates actual publisher job schema
    for(const state of ['processing','publishing','published']){f.job(state);assert.equal((await f.patch({caption:'Blocked'})).status,409);assert.equal(f.post().caption,'Original');}
    f.sql.exec('DELETE FROM instagram_publish_jobs');f.sql.exec("UPDATE posts SET status='published'");
    assert.equal((await f.patch({caption:'Blocked'})).status,409);
  }finally{f.close();}
});
test('publisher claiming after read prevents update atomically',async()=>{
  const f=fixture();try{
    await f.patch({});f.job('pending');
    f.hook(()=>f.sql.exec("UPDATE instagram_publish_jobs SET status='processing'"));
    assert.equal((await f.patch({caption:'Concurrent edit'})).status,409);
    assert.equal(f.post().caption,'Original');
    assert.equal(f.sql.prepare('SELECT status FROM instagram_publish_jobs').get().status,'processing');
  }finally{f.close();}
});
