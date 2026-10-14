import { env } from '@/lib/runtime';
import { ensureInstagramPublishJobs } from '@/lib/instagram-publisher';
import { ensureCalendarRefresh,queueCalendarRefresh,type RefreshPost } from '@/lib/calendar-refresh';
import { launchBackground } from '@/lib/netlify-jobs';
export async function GET(request:Request,context:{params:Promise<{id:string}>}) {
  const owner=request.headers.get('oai-authenticated-user-id');
  if(!owner) return Response.json({error:'Inicia sesión.'},{status:401});
  if(!env.DB) return Response.json({error:'No hay base de datos.'},{status:503});
  const {id}=await context.params;
  await ensureCalendarRefresh(env.DB);
  const rows=await env.DB.prepare('SELECT status,count(*) AS total FROM calendar_refresh WHERE owner_id=? AND brand_id=? GROUP BY status').bind(owner,id).all<{status:string;total:number}>();
  const errors=await env.DB.prepare("SELECT error FROM calendar_refresh WHERE owner_id=? AND brand_id=? AND status IN ('failed','skipped') AND error IS NOT NULL ORDER BY updated_at DESC LIMIT 1").bind(owner,id).first<{error:string}>();
  return Response.json({counts:Object.fromEntries((rows.results??[]).map(r=>[r.status,r.total])),error:errors?.error??null});
}
export async function POST(request:Request,context:{params:Promise<{id:string}>}) {
  const owner=request.headers.get('oai-authenticated-user-id');
  if(!owner) return Response.json({error:'Inicia sesión.'},{status:401});
  if(!env.DB || !env.BUCKET) return Response.json({error:'No está disponible el calendario multimedia.'},{status:503});
  const {id}=await context.params;
  await ensureInstagramPublishJobs(env.DB);
  await ensureCalendarRefresh(env.DB);
  const brand=await env.DB.prepare('SELECT name FROM brand_registry WHERE id=? AND owner_id=? AND active=1').bind(id,owner).first<{name:string}>();
  if(!brand) return Response.json({error:'Marca no encontrada.'},{status:404});
  const rows=await env.DB.prepare(`SELECT p.* FROM posts p WHERE owner_id=? AND brand=? AND status='scheduled' AND media_type='Imagen' AND scheduled_at>?
    AND NOT EXISTS(SELECT 1 FROM calendar_refresh r WHERE r.post_id=p.id) ORDER BY scheduled_at LIMIT 100`).bind(owner,brand.name,new Date(Date.now()+15*60_000).toISOString()).all<RefreshPost>();
  const selected:RefreshPost[]=[];
  for(const row of rows.results??[]) {
    const mediaId=row.media_url.match(/^\/api\/media\/([0-9a-f-]{36})$/i)?.[1];
    if(!mediaId) continue;
    const object=await env.BUCKET.head(`media/${mediaId}`);
    if(object?.customMetadata?.ownerId===owner && object.customMetadata.generatedBy==='social-studio-ai') selected.push(row);
  }
  const queued=await queueCalendarRefresh(env.DB,owner,id,selected);
  // The scheduled minute worker is the durable fallback if launching now fails.
  let started=true;
  try {await launchBackground('agent-background');} catch {started=false;}
  return Response.json({queued,started});
}
