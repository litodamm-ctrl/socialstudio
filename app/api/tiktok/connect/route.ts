import {tiktokDb,tiktokMissing,tiktokCallback,tiktokOrigin} from '@/lib/tiktok';
import {randomUrlSafe} from '@/lib/meta';
export async function GET(request:Request) {
 const owner=request.headers.get('oai-authenticated-user-id');if(!owner)return Response.json({error:'Inicia sesión.'},{status:401});
 const brandId=new URL(request.url).searchParams.get('brandId')||'';
 if(tiktokMissing().length) return Response.redirect(`${tiktokOrigin()}/?tiktok=missing_config`,303);
 try{
  const db=await tiktokDb();
  const brand=await db.prepare('SELECT id FROM brand_registry WHERE owner_id=? AND id=? AND active=1').bind(owner,brandId).first();
  if(!brand)return Response.json({error:'Marca no encontrada.'},{status:404});
  const state=randomUrlSafe();await db.prepare('DELETE FROM tiktok_oauth_states WHERE expires_at<=?').bind(Date.now()).run();
  await db.prepare('INSERT INTO tiktok_oauth_states VALUES(?,?,?,?)').bind(state,owner,brandId,Date.now()+600_000).run();
  const url=new URL('https://www.tiktok.com/v2/auth/authorize/');
  for(const [key,value] of Object.entries({client_key:process.env.TIKTOK_CLIENT_KEY!,response_type:'code',scope:'user.info.basic,video.publish',redirect_uri:tiktokCallback(),state,disable_auto_auth:'1'}))url.searchParams.set(key,value);
  return Response.redirect(url,302);
 }catch{return Response.redirect(`${tiktokOrigin()}/?tiktok=connection_error`,303);}
}
