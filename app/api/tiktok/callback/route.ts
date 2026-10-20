import {tiktokDb,tiktokCallback,tiktokOrigin,requestTikTokToken,tiktokApi} from '@/lib/tiktok';
import {encryptInstagramToken} from '@/lib/meta';
export async function GET(request:Request) {
 const owner=request.headers.get('oai-authenticated-user-id');if(!owner)return Response.json({error:'Inicia sesión.'},{status:401});
 const finish=(code:string)=>Response.redirect(`${tiktokOrigin()}/?tiktok=${code}`,303);
 try{
  const db=await tiktokDb();const url=new URL(request.url);const state=url.searchParams.get('state')||'';
  if(state.length>160)return finish('invalid_state');
  const saved=await db.prepare('DELETE FROM tiktok_oauth_states WHERE state=? AND owner_id=? AND expires_at>? RETURNING brand_id').bind(state,owner,Date.now()).first<{brand_id:string}>();
  if(!saved)return finish('invalid_state');if(url.searchParams.has('error'))return finish('cancelled');
  const code=url.searchParams.get('code');if(!code || code.length>4096)return finish('connection_error');
  const brand=await db.prepare('SELECT id FROM brand_registry WHERE id=? AND owner_id=? AND active=1').bind(saved.brand_id,owner).first();if(!brand)return finish('connection_error');
  const token=await requestTikTokToken({code,grant_type:'authorization_code',redirect_uri:tiktokCallback()});
  if(!token.scope.split(',').includes('video.publish'))return finish('missing_scope');
  const creator=await tiktokApi<{creator_nickname:string}>('post/publish/creator_info/query/',token.access_token,{});
  const existing=await db.prepare('SELECT id,open_id,brand_id,active FROM tiktok_accounts WHERE owner_id=? AND (brand_id=? OR open_id=?)').bind(owner,saved.brand_id,token.open_id).all<{id:string;open_id:string;brand_id:string;active:number}>();
  if(existing.results?.some(row=>Boolean(row.active) && (row.brand_id!==saved.brand_id || row.open_id!==token.open_id)))return finish('account_conflict');
  const now=Date.now();
  await db.prepare(`INSERT INTO tiktok_accounts(id,owner_id,brand_id,open_id,nickname,encrypted_access,encrypted_refresh,access_expires,refresh_expires,scopes,updated_at)
   VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(owner_id,brand_id) DO UPDATE SET open_id=excluded.open_id,nickname=excluded.nickname,encrypted_access=excluded.encrypted_access,encrypted_refresh=excluded.encrypted_refresh,access_expires=excluded.access_expires,refresh_expires=excluded.refresh_expires,scopes=excluded.scopes,active=1,updated_at=excluded.updated_at`)
   .bind(crypto.randomUUID(),owner,saved.brand_id,token.open_id,creator.creator_nickname||'TikTok',await encryptInstagramToken(token.access_token),await encryptInstagramToken(token.refresh_token),now+token.expires_in*1000,now+token.refresh_expires_in*1000,token.scope,now).run();
  return finish('connected');
 }catch{return finish('connection_error');}
}
