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
 sql.close();
});
