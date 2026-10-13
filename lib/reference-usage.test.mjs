import test from 'node:test';
import assert from 'node:assert/strict';
import { rankReferences, referenceKey, loadReferenceUsage } from './reference-usage.ts';
import { DatabaseSync } from 'node:sqlite';
test('randomizes ties, prioritizes unused, avoids recent photos and deduplicates',()=>{
 const now=100*86400000;
 const history=new Map([[referenceKey('recent'),{uses:1,last_used:now-1000}],[referenceKey('old'),{uses:3,last_used:now-10*86400000}]]);
 assert.deepEqual(rankReferences(['recent','old','new','new'],x=>x,history,now,()=>0.5),['new','old','recent']);
 let i=0;assert.deepEqual(rankReferences(['a','b','c'],x=>x,new Map(),now,()=>[.8,.1,.5][i++]),['b','c','a']);
 assert.deepEqual(rankReferences(['recent'],x=>x,history,now),['recent']);
});
test('usage is isolated by owner and brand and preview or failed generation does not mark usage',async()=>{
 const sql=new DatabaseSync(':memory:');
 const db={prepare(q){return{bind(...args){return {q,args,async all(){return {results:sql.prepare(q).all(...args)}},async run(){return sql.prepare(q).run(...args)}}},async run(){return sql.prepare(q).run()}}},async batch(stmts){return stmts.map(s=>sql.prepare(s.q).run(...s.args))}};
 const a=await loadReferenceUsage(db,'owner','Bahia');a.mark('one');a.mark('one');
 assert.equal(sql.prepare('SELECT COUNT(*) n FROM brand_reference_usage').get().n,0);
 await a.commit();assert.equal(sql.prepare('SELECT uses FROM brand_reference_usage').get().uses,1);
 const other=await loadReferenceUsage(db,'owner','Manglar');assert.equal(other.rank(['one'],x=>x).length,1);
 assert.equal(sql.prepare("SELECT COUNT(*) n FROM brand_reference_usage WHERE brand='Manglar'").get().n,0);
 const feed=await loadReferenceUsage(db,'owner','Bahia','feed');feed.markImage('photo-a');await feed.commit();
 const feedNext=await loadReferenceUsage(db,'owner','Bahia','feed');
 assert.deepEqual(feedNext.rankImages(['photo-a','photo-b','photo-b'],x=>x),['photo-b','photo-a']);
 const story=await loadReferenceUsage(db,'owner','Bahia','story');story.markImage('photo-b');await story.commit();
 const feedAfterStory=await loadReferenceUsage(db,'owner','Bahia','feed');
 assert.deepEqual(feedAfterStory.rankImages(['photo-a','photo-b'],x=>x),['photo-b','photo-a']);
 sql.close();
});
test('feed exhausts available product identities across web, Drive and uploads before repeating',async()=>{
 const sql=new DatabaseSync(':memory:');
 const db={prepare(q){return{bind(...args){return {q,args,async all(){return {results:sql.prepare(q).all(...args)}},async run(){return sql.prepare(q).run(...args)}}},async run(){return sql.prepare(q).run()}}},async batch(stmts){return stmts.map(s=>sql.prepare(s.q).run(...s.args))}};
 const candidates=[{source:'web:a',identity:'same-photo'},{source:'drive:a',identity:'same-photo'},{source:'drive:b',identity:'photo-b'},{source:'asset:c',identity:'photo-c'}];
 const selected=[];
 for(let day=0;day<3;day++){
  const usage=await loadReferenceUsage(db,'owner','Manglar','feed');
  const choice=usage.rankImages(candidates,item=>item.identity)[0];
  selected.push(choice.identity);usage.mark(choice.source);usage.markImage(choice.identity);await usage.commit();
 }
 assert.equal(new Set(selected).size,3);
 // Only the chosen product is recorded, never every material offered to the agent.
 assert.equal(sql.prepare('SELECT SUM(uses) n FROM brand_reference_usage').get().n,6);
 sql.close();
});
