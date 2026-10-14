export type RefreshPost = { id:string; owner_id:string; brand:string; caption:string; media_type:string; media_url:string; scheduled_at:string; status:string };
export async function ensureCalendarRefresh(db:D1Database) {
  await db.prepare(`CREATE TABLE IF NOT EXISTS calendar_refresh (
    post_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, brand_id TEXT NOT NULL,
    original_media TEXT NOT NULL, original_caption TEXT NOT NULL, scheduled_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
    claim_id TEXT, updated_at INTEGER NOT NULL, error TEXT, replacement_media TEXT
  )`).run();
}
// Moving a selected post to draft holds the OLD image while keeping its original date.
// A final compare-and-swap prevents an edit, cancellation or publication being overwritten.
export async function queueCalendarRefresh(db:D1Database, owner:string, brandId:string, posts:RefreshPost[], now=Date.now()) {
  await ensureCalendarRefresh(db);
  let queued=0;
  for(const post of posts) {
    if(post.owner_id!==owner || post.media_type!=="Imagen" || post.status!=="scheduled" || Date.parse(post.scheduled_at)<=now+15*60_000) continue;
    const rows=await db.batch([
      db.prepare(`INSERT OR IGNORE INTO calendar_refresh(post_id,owner_id,brand_id,original_media,original_caption,scheduled_at,updated_at)
        SELECT id,owner_id,?,media_url,caption,scheduled_at,? FROM posts p
        WHERE id=? AND owner_id=? AND status='scheduled' AND media_type='Imagen' AND media_url=? AND caption=? AND scheduled_at=?
        AND NOT EXISTS(SELECT 1 FROM instagram_publish_jobs j WHERE j.post_id=p.id AND (j.status IN ('processing','publishing','published') OR j.container_id IS NOT NULL))`)
        .bind(brandId,now,post.id,owner,post.media_url,post.caption,post.scheduled_at),
      db.prepare(`UPDATE posts SET status='draft' WHERE id=? AND owner_id=? AND status='scheduled'
        AND EXISTS(SELECT 1 FROM calendar_refresh r WHERE r.post_id=posts.id AND r.owner_id=posts.owner_id AND r.status='pending' AND r.original_media=posts.media_url AND r.original_caption=posts.caption AND r.scheduled_at=posts.scheduled_at)
        AND NOT EXISTS(SELECT 1 FROM instagram_publish_jobs j WHERE j.post_id=posts.id AND (j.status IN ('processing','publishing','published') OR j.container_id IS NOT NULL))`).bind(post.id,owner),
    ]);
    queued+=rows[1]?.meta.changes ?? 0;
  }
  return queued;
}
export async function processCalendarRefresh(db:D1Database, generate:(request:Request)=>Promise<Response>, claim:string, now=Date.now()) {
  await ensureCalendarRefresh(db);
  const row=await db.prepare(`SELECT r.*,p.brand,p.media_type FROM calendar_refresh r
    JOIN posts p ON p.id=r.post_id AND p.owner_id=r.owner_id
    JOIN brand_registry b ON b.id=r.brand_id AND b.owner_id=r.owner_id
    WHERE b.active=1 AND r.attempts<3 AND (r.status='pending' OR (r.status IN ('processing','failed') AND r.updated_at<?))
    ORDER BY r.scheduled_at,r.updated_at LIMIT 1`).bind(now-12*60_000).first<{
      post_id:string;owner_id:string;brand_id:string;brand:string;media_type:string;scheduled_at:string;original_media:string;original_caption:string;
    }>();
  if(!row) return false;
  const current=await db.prepare(`SELECT id FROM posts p WHERE id=? AND owner_id=? AND status='draft' AND media_url=? AND caption=? AND scheduled_at=?
    AND NOT EXISTS(SELECT 1 FROM instagram_publish_jobs j WHERE j.post_id=p.id AND (j.status IN ('processing','publishing','published') OR j.container_id IS NOT NULL))`)
    .bind(row.post_id,row.owner_id,row.original_media,row.original_caption,row.scheduled_at).first();
  if(!current || Date.parse(row.scheduled_at)<=now+15*60_000) {
    await db.prepare("UPDATE calendar_refresh SET status='skipped',error=?,updated_at=? WHERE post_id=?")
      .bind(current?"La fecha venció durante la reparación. El original queda en borrador; no se publica atrasado.":"La pieza fue editada, cancelada o enviada. Se conservó el cambio.",now,row.post_id).run();
    return true;
  }
  await db.prepare("UPDATE calendar_refresh SET status='processing',attempts=attempts+1,claim_id=?,updated_at=?,error=NULL WHERE post_id=?").bind(claim,now,row.post_id).run();
  try {
    const response=await generate(new Request("https://internal/api/agent/generate",{method:"POST",headers:{"content-type":"application/json","oai-authenticated-user-id":row.owner_id},body:JSON.stringify({
      brand:row.brand,objective:"Comunidad",mediaType:"Imagen",scheduledDate:row.scheduled_at.slice(0,10),
      brief:"Renueva esta publicación con otra fotografía del catálogo real de la marca, seleccionada por rotación. Evita imágenes y productos dominantes en el calendario reciente. Redacta un nuevo copy coherente con la foto elegida.",
      callToAction:"Invita a conocer la marca o consultar por mensaje, sin inventar ofertas.",
    })}));
    const result=await response.json() as {mediaUrl?:string;caption?:string;error?:string};
    if(!response.ok || !result.mediaUrl || !result.caption) throw new Error(result.error || "El agente no devolvió una pieza completa.");
    await db.batch([
      db.prepare(`UPDATE posts SET media_url=?,caption=?,status='scheduled' WHERE id=? AND owner_id=? AND status='draft'
        AND media_url=? AND caption=? AND scheduled_at=? AND scheduled_at>?
        AND EXISTS(SELECT 1 FROM calendar_refresh WHERE post_id=posts.id AND status='processing' AND claim_id=?)
        AND EXISTS(SELECT 1 FROM brand_registry WHERE id=? AND owner_id=? AND active=1)
        AND NOT EXISTS(SELECT 1 FROM instagram_publish_jobs j WHERE j.post_id=posts.id AND (j.status IN ('processing','publishing','published') OR j.container_id IS NOT NULL))`)
        .bind(result.mediaUrl,result.caption,row.post_id,row.owner_id,row.original_media,row.original_caption,row.scheduled_at,new Date(Date.now()+15*60_000).toISOString(),claim,row.brand_id,row.owner_id),
      db.prepare(`UPDATE calendar_refresh SET status=CASE WHEN EXISTS(SELECT 1 FROM posts p WHERE p.id=calendar_refresh.post_id AND p.owner_id=calendar_refresh.owner_id AND p.media_url=?) THEN 'completed' ELSE 'skipped' END,
        replacement_media=?,updated_at=? WHERE post_id=? AND claim_id=? AND status='processing'`).bind(result.mediaUrl,result.mediaUrl,Date.now(),row.post_id,claim),
      db.prepare(`DELETE FROM instagram_publish_jobs WHERE post_id=? AND owner_id=? AND status IN ('pending','failed') AND container_id IS NULL
        AND EXISTS(SELECT 1 FROM calendar_refresh WHERE post_id=? AND status='completed' AND claim_id=?)`).bind(row.post_id,row.owner_id,row.post_id,claim),
    ]);
  } catch(error) {
    await db.prepare("UPDATE calendar_refresh SET status='failed',error=?,updated_at=? WHERE post_id=? AND claim_id=?")
      .bind(error instanceof Error?error.message.slice(0,300):"No se pudo renovar el creativo.",Date.now(),row.post_id,claim).run();
  }
  return true;
}
