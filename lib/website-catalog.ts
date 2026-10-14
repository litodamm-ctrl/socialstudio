import { extractWebsitePage,fetchPublicResource,MAX_WEBSITE_BYTES,type WebsitePage } from './website-sources';
export function catalogLinks(html:string,base:string) {
  const origin=new URL(base).origin;
  const links:string[]=[];
  for(const match of html.matchAll(/<a\b[^>]*\bhref\s*=\s*["']([^"']+)["']/gi)) {
    try {
      const url=new URL(match[1].replace(/&amp;/g,'&'),base);url.hash='';
      if(url.origin!==origin || !/\/(products?|collections?|catalogo|categorias?)\//i.test(url.pathname) || /\/(cart|account|checkout)\b/i.test(url.pathname)) continue;
      url.search='';if(!links.includes(url.href)) links.push(url.href);
    } catch { /* Invalid link */ }
  }
  return links.sort((a,b)=>Number(!/\/products?\//i.test(a))-Number(!/\/products?\//i.test(b))).slice(0,24);
}
export async function expandedWebsiteCatalog(db:D1Database,page:WebsitePage) {
  await db.prepare('CREATE TABLE IF NOT EXISTS website_catalog_cache(url TEXT PRIMARY KEY,pages TEXT NOT NULL,updated_at INTEGER NOT NULL)').run();
  const cached=await db.prepare('SELECT pages FROM website_catalog_cache WHERE url=? AND updated_at>?').bind(page.url,Date.now()-24*60*60_000).first<{pages:string}>();
  if(cached) return JSON.parse(cached.pages) as WebsitePage[];
  const root=await fetchPublicResource(page.url,MAX_WEBSITE_BYTES);
  const queue=catalogLinks(root.bytes.toString('utf8'),root.url);
  const pages:WebsitePage[]=[page];const visited=new Set([page.url]);const deadline=Date.now()+30_000;
  for(let offset=0;offset<queue.length && offset<24 && Date.now()<deadline;offset+=4) {
    const batch=await Promise.all(queue.slice(offset,offset+4).map(async url=>{
      if(visited.has(url)) return null;visited.add(url);
      try {const file=await fetchPublicResource(url,MAX_WEBSITE_BYTES);if(new URL(file.url).origin!==new URL(page.url).origin || !/html/.test(file.contentType))return null;return extractWebsitePage(file.bytes.toString('utf8'),file.url);} catch {return null;}
    }));
    for(const item of batch) if(item && item.images.length) pages.push(item);
  }
  await db.prepare('INSERT INTO website_catalog_cache(url,pages,updated_at) VALUES(?,?,?) ON CONFLICT(url) DO UPDATE SET pages=excluded.pages,updated_at=excluded.updated_at').bind(page.url,JSON.stringify(pages),Date.now()).run();
  return pages;
}
