import {env} from '@/lib/runtime';
import {TikTokRejected,ensureTikTok,tiktokAccess,tiktokApi,tiktokOrigin,tiktokAudited,type TikTokAccount} from './tiktok';
import {photoPostBody,type TikTokPostOptions,type TikTokCreator} from './tiktok-policy';
export async function processDueTikTokPublications(db:D1Database) {
 if(!process.env.TIKTOK_CLIENT_KEY||!process.env.TIKTOK_CLIENT_SECRET)return;
 await ensureTikTok(db);const now=Date.now();const claim=crypto.randomUUID();
 await db.prepare("INSERT OR IGNORE INTO tiktok_worker(id,lease_until) VALUES('publish',0)").run();
 const lock=await db.prepare("UPDATE tiktok_worker SET lease_until=?,claim_id=? WHERE id='publish' AND lease_until<? RETURNING id").bind(now+360_000,claim,now).first();if(!lock)return;
 try{
  await db.prepare("UPDATE tiktok_jobs SET status='uncertain',error='No se confirmó el envío. Comprueba TikTok antes de volver a publicar.',media_token=NULL WHERE status='sending' AND lease_until<?").bind(now).run();
  const rows=await db.prepare(`SELECT * FROM tiktok_jobs WHERE (status='queued' AND scheduled_at<=?) OR (status='processing' AND publish_id IS NOT NULL) ORDER BY scheduled_at LIMIT 4`).bind(new Date(now).toISOString()).all<{
   id:string;owner_id:string;brand_id:string;post_id:string;account_id:string;open_id:string;media_url:string;options:string;is_aigc:number;status:string;publish_id:string|null;media_token:string;scheduled_at:string;
  }>();
  for(const job of rows.results??[]) {
   let sent=job.status==='processing';
   try{
    const account=await db.prepare(`SELECT a.* FROM tiktok_accounts a JOIN brand_registry b ON b.id=a.brand_id AND b.owner_id=a.owner_id WHERE a.id=? AND a.owner_id=? AND a.open_id=? AND a.active=1 AND b.active=1`).bind(job.account_id,job.owner_id,job.open_id).first<TikTokAccount>();
    if(!account)throw new Error('La cuenta o la marca fue desconectada.');
    const token=await tiktokAccess(db,account);
    let publishId=job.publish_id;
    if(!publishId) {
     if(Date.parse(job.scheduled_at)<Date.now()-3600_000)throw new Error('La fecha venció; revisa la pieza antes de programarla de nuevo.');
     const options=JSON.parse(job.options) as TikTokPostOptions;
     const creator=await tiktokApi<TikTokCreator>('post/publish/creator_info/query/',token,{});
     if(!creator.privacy_level_options.includes(options.privacy) || (!tiktokAudited()&&options.privacy!=='SELF_ONLY') || (creator.comment_disabled&&options.allowComments))throw new Error('Los permisos de publicación cambiaron. Revisa la privacidad y los comentarios.');
     if(process.env.TIKTOK_MEDIA_DOMAIN_VERIFIED!=='true')throw new Error('Falta verificar el dominio multimedia con TikTok.');
     const source=await db.prepare(`SELECT p.id FROM posts p JOIN brand_registry b ON b.owner_id=p.owner_id AND b.name=p.brand WHERE p.id=? AND p.owner_id=? AND p.media_url=? AND p.media_type='Imagen' AND b.id=? AND b.active=1`).bind(job.post_id,job.owner_id,job.media_url,job.brand_id).first();
     if(!source)throw new Error('La foto original fue cambiada o eliminada. Revisa el contenido antes de publicarlo.');
     const mediaId=job.media_url.match(/^\/api\/media\/([a-f0-9-]{36})$/i)?.[1];
     const media=mediaId&&env.BUCKET?await env.BUCKET.head(`media/${mediaId}`):null;
     if(!media || media.customMetadata?.ownerId!==job.owner_id)throw new Error('La foto original ya no está disponible.');
     const reserved=await db.prepare(`UPDATE tiktok_jobs SET status='sending',lease_until=?,updated_at=? WHERE id=? AND owner_id=? AND status='queued'
       AND EXISTS(SELECT 1 FROM tiktok_accounts WHERE id=tiktok_jobs.account_id AND owner_id=tiktok_jobs.owner_id AND open_id=tiktok_jobs.open_id AND active=1) RETURNING id`).bind(Date.now()+300_000,Date.now(),job.id,job.owner_id).first();
     if(!reserved)continue;
     sent=true;
     const result=await tiktokApi<{publish_id:string}>('post/publish/content/init/',token,photoPostBody(options,`${tiktokOrigin()}/api/tiktok/media/${job.media_token}`,Boolean(job.is_aigc)));
     if(!result.publish_id)throw new Error('TikTok no confirmó el identificador de envío.');
     publishId=result.publish_id;
     await db.prepare("UPDATE tiktok_jobs SET status='processing',publish_id=?,error=NULL,updated_at=? WHERE id=? AND status='sending'").bind(publishId,Date.now(),job.id).run();
    }
    const status=await tiktokApi<{status:string;fail_reason?:string}>('post/publish/status/fetch/',token,{publish_id:publishId});
    if(status.status==='PUBLISH_COMPLETE')await db.prepare("UPDATE tiktok_jobs SET status='published',error=NULL,media_token=NULL,updated_at=? WHERE id=? AND status='processing'").bind(Date.now(),job.id).run();
    else if(status.status==='FAILED')await db.prepare("UPDATE tiktok_jobs SET status='failed',error='TikTok rechazó la publicación. Revisa el archivo, la cuenta y sus permisos.',media_token=NULL,updated_at=? WHERE id=? AND status='processing'").bind(Date.now(),job.id).run();
   }catch(error){
    const message=error instanceof Error?error.message.slice(0,240):'No se pudo confirmar TikTok.';
    // Never repeat an ambiguous initiation: TikTok may have accepted it.
    await db.prepare(`UPDATE tiktok_jobs SET status=CASE WHEN status='sending' THEN ? WHEN status='queued' THEN 'failed' ELSE status END,error=?,updated_at=? WHERE id=? AND status IN ('queued','sending','processing')`).bind(error instanceof TikTokRejected?'failed':'uncertain',message,Date.now(),job.id).run();
    if(!sent)await db.prepare("UPDATE tiktok_jobs SET media_token=NULL WHERE id=? AND status='failed'").bind(job.id).run();
   }
  }
 }finally{await db.prepare("UPDATE tiktok_worker SET lease_until=0 WHERE id='publish' AND claim_id=?").bind(claim).run();}
}
