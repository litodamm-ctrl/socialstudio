import {env} from '@/lib/runtime';
import {tiktokDb,tiktokAccount,tiktokCreator,tiktokAudited} from '@/lib/tiktok';
import {validateTikTokPost} from '@/lib/tiktok-policy';
import {randomUrlSafe} from '@/lib/meta';
export async function GET(request:Request) {
 const owner=request.headers.get('oai-authenticated-user-id');if(!owner)return Response.json({error:'Inicia sesión.'},{status:401});
 try{const db=await tiktokDb();const jobs=await db.prepare('SELECT id,brand_id,post_id,nickname,scheduled_at,status,error,updated_at FROM tiktok_jobs WHERE owner_id=? ORDER BY scheduled_at DESC LIMIT 200').bind(owner).all();return Response.json({jobs:jobs.results??[]});}catch{return Response.json({error:'No se pudo cargar la cola TikTok.'},{status:503});}
}
export async function POST(request:Request) {
 const owner=request.headers.get('oai-authenticated-user-id');if(!owner)return Response.json({error:'Inicia sesión.'},{status:401});
 try{
  const raw=await request.json() as Record<string,unknown>;const db=await tiktokDb();
  if(process.env.TIKTOK_MEDIA_DOMAIN_VERIFIED!=='true')return Response.json({error:'Verifica el dominio de las imágenes en TikTok for Developers antes de programar.'},{status:409});
  const brandId=typeof raw.brandId==='string'?raw.brandId:'';const postId=typeof raw.postId==='string'?raw.postId:'';
  const post=await db.prepare(`SELECT p.media_url,p.media_type FROM posts p JOIN brand_registry b ON b.owner_id=p.owner_id AND b.name=p.brand WHERE p.id=? AND p.owner_id=? AND b.id=? AND b.active=1`)
    .bind(postId,owner,brandId).first<{media_url:string;media_type:string}>();
  if(!post || post.media_type!=='Imagen')return Response.json({error:'Selecciona una imagen de feed de esta marca.'},{status:400});
  const account=await tiktokAccount(db,owner,brandId);if(!account)return Response.json({error:'Conecta TikTok para esta marca.'},{status:409});
  const options=validateTikTokPost(raw,await tiktokCreator(db,account),tiktokAudited());
  const mediaId=post.media_url.match(/^\/api\/media\/([a-f0-9-]{36})$/i)?.[1];
  const object=mediaId&&env.BUCKET?await env.BUCKET.head(`media/${mediaId}`):null;
  if(!object || object.customMetadata?.ownerId!==owner || object.httpMetadata?.contentType!=='image/jpeg')return Response.json({error:'La foto no está disponible como JPG.'},{status:400});
  const id=crypto.randomUUID();const now=Date.now();
  const inserted=await db.prepare(`INSERT INTO tiktok_jobs(id,owner_id,brand_id,post_id,account_id,open_id,nickname,media_url,options,is_aigc,scheduled_at,media_token,media_expires,created_at,updated_at)
    SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM tiktok_accounts WHERE id=? AND owner_id=? AND active=1 AND open_id=?) ON CONFLICT(owner_id,post_id,open_id) DO UPDATE SET account_id=excluded.account_id,nickname=excluded.nickname,media_url=excluded.media_url,options=excluded.options,is_aigc=excluded.is_aigc,scheduled_at=excluded.scheduled_at,media_token=excluded.media_token,media_expires=excluded.media_expires,status='queued',publish_id=NULL,lease_until=0,error=NULL,updated_at=excluded.updated_at WHERE tiktok_jobs.status IN ('failed','cancelled') RETURNING id`)
    .bind(id,owner,brandId,postId,account.id,account.open_id,account.nickname,post.media_url,JSON.stringify(options),object.customMetadata.generatedBy==='social-studio-ai'||raw.isAigc===true?1:0,options.scheduledAt,randomUrlSafe(48),Date.parse(options.scheduledAt)+86400_000,now,now,account.id,owner,account.open_id).first<{id:string}>();
  if(!inserted)return Response.json({error:'Esta pieza ya está registrada para esa cuenta o la conexión cambió. Revisa la cola.'},{status:409});
  return Response.json({id:inserted.id,status:'queued'},{status:201});
 }catch(error){return Response.json({error:error instanceof Error?error.message:'No se pudo programar en TikTok.'},{status:400});}
}
export async function DELETE(request:Request) {
 const owner=request.headers.get('oai-authenticated-user-id');if(!owner)return Response.json({error:'Inicia sesión.'},{status:401});
 try{const {id}=await request.json() as {id?:unknown};const db=await tiktokDb();const cancelled=await db.prepare("UPDATE tiktok_jobs SET status='cancelled',media_token=NULL,updated_at=? WHERE id=? AND owner_id=? AND status='queued' RETURNING id").bind(Date.now(),String(id),owner).first();
 return cancelled?Response.json({cancelled:true}):Response.json({error:'La publicación ya se envió a TikTok o está procesándose.'},{status:409});
 }catch{return Response.json({error:'No se pudo cancelar.'},{status:503});}
}
