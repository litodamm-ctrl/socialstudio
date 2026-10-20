import {env} from '@/lib/runtime';
import {tiktokDb} from '@/lib/tiktok';
export async function GET(_request:Request,context:{params:Promise<{token:string}>}) {
 const {token}=await context.params;if(!/^[A-Za-z0-9_-]{64}$/.test(token)||!env.BUCKET)return new Response('Not found',{status:404});
 const db=await tiktokDb();
 const job=await db.prepare(`SELECT j.media_url,j.owner_id FROM tiktok_jobs j JOIN tiktok_accounts a ON a.id=j.account_id AND a.owner_id=j.owner_id AND a.open_id=j.open_id
  WHERE j.media_token=? AND j.media_expires>? AND j.status IN ('sending','processing') AND a.active=1`).bind(token,Date.now()).first<{media_url:string;owner_id:string}>();
 const id=job?.media_url.match(/^\/api\/media\/([a-f0-9-]{36})$/i)?.[1];if(!job||!id)return new Response('Not found',{status:404});
 const object=await env.BUCKET.get(`media/${id}`);
 if(!object || object.customMetadata?.ownerId!==job.owner_id || object.httpMetadata?.contentType!=='image/jpeg')return new Response('Not found',{status:404});
 return new Response(_request.method==='HEAD'?null:object.body,{headers:{'content-type':'image/jpeg','content-length':String(object.size),'cache-control':'private, no-store','x-content-type-options':'nosniff','referrer-policy':'no-referrer'}});
}

export const HEAD=GET;
