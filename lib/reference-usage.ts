import { createHash } from 'node:crypto';
export type ReferenceHistory = Map<string, { uses: number; last_used: number }>;
export function referenceKey(source: string) { return createHash('sha256').update(source).digest('hex'); }
export function rankReferences<T>(items: T[], key: (item:T)=>string, history:ReferenceHistory, now=Date.now(), random= Math.random): T[] {
  const seen = new Set<string>();
  return items.filter(item=>{const id=referenceKey(key(item));if(seen.has(id))return false;seen.add(id);return true;}).map(item=>({item,stat:history.get(referenceKey(key(item))) ?? {uses:0,last_used:0}, tie:random()}))
    .sort((a,b)=>Number(a.stat.last_used > now-7*86400000)-Number(b.stat.last_used > now-7*86400000) || a.stat.uses-b.stat.uses || a.stat.last_used-b.stat.last_used || a.tie-b.tie).map(row=>row.item);
}
export async function loadReferenceUsage(db:D1Database,owner:string,brand:string) {
  await db.prepare(`CREATE TABLE IF NOT EXISTS brand_reference_usage (owner_id TEXT NOT NULL, brand TEXT NOT NULL, source_key TEXT NOT NULL, uses INTEGER NOT NULL DEFAULT 0, last_used INTEGER NOT NULL, PRIMARY KEY(owner_id,brand,source_key))`).run();
  const rows=await db.prepare('SELECT source_key, uses, last_used FROM brand_reference_usage WHERE owner_id = ? AND brand = ?').bind(owner,brand).all<{source_key:string;uses:number;last_used:number}>();
  const history:ReferenceHistory = new Map((rows.results ?? []).map(row=>[row.source_key,row]));
  const used = new Set<string>();
  return {
    rank<T>(items:T[],key:(item:T)=>string) {return rankReferences(items,key,history);},
    mark(source:string) {used.add(referenceKey(source));},
    async commit() {
      if (!used.size) return;
      await db.batch([...used].map(key=>db.prepare(`INSERT INTO brand_reference_usage(owner_id,brand,source_key,uses,last_used) VALUES(?,?,?,1,?) ON CONFLICT(owner_id,brand,source_key) DO UPDATE SET uses=uses+1,last_used=excluded.last_used`).bind(owner,brand,key,Date.now())));
    }
  };
}
export type ReferenceUsage = Awaited<ReturnType<typeof loadReferenceUsage>>;
