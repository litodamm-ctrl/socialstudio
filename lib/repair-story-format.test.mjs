import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {stripTypeScriptTypes} from 'node:module';
import {DatabaseSync} from 'node:sqlite';

test('repair is copy-on-write, idempotent and excludes published or claimed posts',async()=>{
  const source=(await readFile(new URL('./repair-story-format.ts',import.meta.url),'utf8')).replace(/^import .*;\n/gm,'');
  const m=await import('data:text/javascript;base64,'+Buffer.from(stripTypeScriptTypes('const formatStory=async()=>new Uint8Array([1]);\n'+source)).toString('base64'));
  const sql=new DatabaseSync(':memory:');
  const db={prepare(q){const s=sql.prepare(q);let a=[];return{bind(...v){a=v;return this;},async run(){return s.run(...a);},async first(){return s.get(...a);},async all(){return{results:s.all(...a)};}};}};
  sql.exec(`CREATE TABLE posts(id TEXT,owner_id TEXT,media_url TEXT,status TEXT,media_type TEXT,scheduled_at TEXT);
    CREATE TABLE instagram_publish_jobs(post_id TEXT);
    INSERT INTO posts VALUES('future','owner','/api/media/11111111-1111-1111-1111-111111111111','scheduled','Historia','2099-01-01');
    INSERT INTO posts SELECT 'published',owner_id,media_url,'published',media_type,scheduled_at FROM posts WHERE id='future';
    INSERT INTO posts SELECT 'claimed',owner_id,media_url,status,media_type,scheduled_at FROM posts WHERE id='future';
    INSERT INTO instagram_publish_jobs VALUES('claimed');`);
  const writes=[];
  sql.exec(`CREATE TABLE story_format_repairs(post_id TEXT,original_url TEXT,result TEXT,checked_at INTEGER,PRIMARY KEY(post_id,original_url));
    INSERT INTO story_format_repairs VALUES('future','/api/media/22222222-2222-2222-2222-222222222222','repaired',1);
    INSERT INTO story_format_repairs VALUES('future','/api/media/33333333-3333-3333-3333-333333333333','repaired',2);`);
  const bucket={async get(){return{size:1,customMetadata:{ownerId:'owner',generatedBy:'social-studio-ai'},async arrayBuffer(){return new ArrayBuffer(1);}};},async put(key,bytes,opts){writes.push({key,opts});}};
  try{
    await m.repairPendingStories(db,bucket);
    assert.equal(writes.length,1);
    assert.equal(writes[0].opts.customMetadata.originalMediaId,'22222222-2222-2222-2222-222222222222');
    for(const id of ['published','claimed'])assert.equal(sql.prepare('SELECT media_url FROM posts WHERE id=?').get(id).media_url,'/api/media/11111111-1111-1111-1111-111111111111');
    bucket.get=async()=>({customMetadata:{ownerId:'owner',generatedBy:'social-studio-ai',storyformat:'9x16-v3'}});
    await m.repairPendingStories(db,bucket);await m.repairPendingStories(db,bucket);
    assert.equal(writes.length,1);
    sql.prepare("DELETE FROM story_format_repairs_v3").run();
    bucket.get=async()=>({customMetadata:{ownerId:'owner',generatedBy:'social-studio-ai',storyformat:'9x16-v4'}});
    await m.repairPendingStories(db,bucket);
    assert.equal(writes.length,1,'full-bleed stories must never be padded or reprocessed');
  }finally{sql.close();}
});

test('reviewed October 10 stories lose bands once, without changing dates or other posts',async()=>{
  const source=(await readFile(new URL('./repair-story-format.ts',import.meta.url),'utf8')).replace(/^import .*;\n/gm,'');
  const calls=[];
  const m=await import('data:text/javascript;base64,'+Buffer.from(stripTypeScriptTypes('const formatStory=async(bytes,strip,bleed)=>{if(!strip||!bleed)throw Error("Must remove bands and fill canvas");return new Uint8Array([1]);};\n'+source)).toString('base64'));
  const sql=new DatabaseSync(':memory:');
  const db={prepare(q){const s=sql.prepare(q);let a=[];return{bind(...v){a=v;return this;},async run(){return s.run(...a);},async first(){return s.get(...a);},async all(){return{results:s.all(...a)};}};}};
  const ids=['5311f4f2-4dfb-4536-b4ae-9e6a4058cc8e','3a59c7cd-fdb4-47b2-9d83-4c6c5a1e4da0','796850e2-afad-426f-919c-c4387bc93026'];
  sql.exec('CREATE TABLE posts(id TEXT,owner_id TEXT,media_url TEXT,status TEXT,media_type TEXT,scheduled_at TEXT);CREATE TABLE instagram_publish_jobs(post_id TEXT);');
  const insert=sql.prepare('INSERT INTO posts VALUES(?,?,?,?,?,?)');
  ids.forEach((id,i)=>insert.run(String(i),'owner','/api/media/'+id,'scheduled','Historia','2099-01-01'));
  insert.run('published','owner','/api/media/'+ids[0],'published','Historia','2099-01-01');
  insert.run('claimed','owner','/api/media/'+ids[0],'scheduled','Historia','2099-01-01');
  sql.exec("INSERT INTO instagram_publish_jobs VALUES('claimed')");
  const bucket={async get(){return{size:1,customMetadata:{ownerId:'owner',generatedBy:'social-studio-ai',storyformat:'9x16-v3'},async arrayBuffer(){return new ArrayBuffer(1);}};},async put(key,bytes,opts){calls.push({key,opts});}};
  try{
    await m.repairReviewedStories(db,bucket);
    await m.repairReviewedStories(db,bucket);
    assert.equal(calls.length,3);
    assert.ok(calls.every(c=>c.opts.customMetadata.storyFormat==='9x16-v4'));
    assert.ok(sql.prepare('SELECT * FROM posts').all().every(p=>p.scheduled_at==='2099-01-01'));
    for(const id of ['published','claimed'])assert.equal(sql.prepare('SELECT media_url FROM posts WHERE id=?').get(id).media_url,'/api/media/'+ids[0]);
  }finally{sql.close();}
});
