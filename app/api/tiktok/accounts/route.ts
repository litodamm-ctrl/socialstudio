import {tiktokDb,tiktokMissing,tiktokAudited,tiktokAccount} from '@/lib/tiktok';
import {decryptInstagramToken} from '@/lib/meta';
export async function GET(request:Request) {
 const owner=request.headers.get('oai-authenticated-user-id');if(!owner)return Response.json({error:'Inicia sesión.'},{status:401});
 try{const db=await tiktokDb();const rows=await db.prepare('SELECT brand_id,nickname FROM tiktok_accounts WHERE owner_id=? AND active=1').bind(owner).all();return Response.json({accounts:rows.results??[],missing:tiktokMissing(),audited:tiktokAudited(),domainVerified:process.env.TIKTOK_MEDIA_DOMAIN_VERIFIED==='true'});}catch{return Response.json({error:'No se pudo consultar TikTok.'},{status:503});}
}
export async function DELETE(request:Request) {
 const owner=request.headers.get('oai-authenticated-user-id');if(!owner)return Response.json({error:'Inicia sesión.'},{status:401});
 try{const {brandId}=await request.json() as {brandId?:unknown};const db=await tiktokDb();const account=await tiktokAccount(db,owner,String(brandId));if(!account)return Response.json({error:'Cuenta no encontrada.'},{status:404});
  const response=await fetch('https://open.tiktokapis.com/v2/oauth/revoke/',{method:'POST',signal:AbortSignal.timeout(20_000),headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_key:process.env.TIKTOK_CLIENT_KEY||'',client_secret:process.env.TIKTOK_CLIENT_SECRET||'',token:await decryptInstagramToken(account.encrypted_access)})});
  const result=await response.json() as {error?:string|{code?:string}};
  const rejected=typeof result.error==='string'?Boolean(result.error):Boolean(result.error?.code&&result.error.code!=='ok');
  if(!response.ok||rejected)return Response.json({error:'TikTok no confirmó la revocación. Intenta de nuevo.'},{status:502});
  await db.batch([db.prepare("UPDATE tiktok_accounts SET active=0,open_id='disconnected:'||id,encrypted_access='',encrypted_refresh='',updated_at=? WHERE id=? AND owner_id=?").bind(Date.now(),account.id,owner),db.prepare("UPDATE tiktok_jobs SET status='cancelled',media_token=NULL WHERE account_id=? AND owner_id=? AND status='queued'").bind(account.id,owner)]);
  return Response.json({disconnected:true});
 }catch{return Response.json({error:'No se pudo desconectar TikTok.'},{status:503});}
}
