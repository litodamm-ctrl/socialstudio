import {env} from '@/lib/runtime';
import {encryptInstagramToken,decryptInstagramToken} from '@/lib/meta';
import type {TikTokCreator} from './tiktok-policy';
export const tiktokOrigin=()=>new URL(process.env.SITE_ORIGIN||'https://socialstudioig.netlify.app').origin;
export const tiktokCallback=()=>`${tiktokOrigin()}/api/tiktok/callback`;
export const tiktokAudited=()=>process.env.TIKTOK_DIRECT_POST_APPROVED==='true';
export function tiktokMissing() {return ['TIKTOK_CLIENT_KEY','TIKTOK_CLIENT_SECRET','INSTAGRAM_TOKEN_ENCRYPTION_KEY','SITE_ORIGIN'].filter(key=>!process.env[key]);}
export async function ensureTikTok(db:D1Database) {
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS tiktok_accounts(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,brand_id TEXT NOT NULL,open_id TEXT NOT NULL,nickname TEXT NOT NULL,encrypted_access TEXT NOT NULL,encrypted_refresh TEXT NOT NULL,access_expires INTEGER NOT NULL,refresh_expires INTEGER NOT NULL,scopes TEXT NOT NULL,active INTEGER NOT NULL DEFAULT 1,updated_at INTEGER NOT NULL,UNIQUE(owner_id,brand_id),UNIQUE(owner_id,open_id))`),
    db.prepare('CREATE TABLE IF NOT EXISTS tiktok_oauth_states(state TEXT PRIMARY KEY,owner_id TEXT NOT NULL,brand_id TEXT NOT NULL,expires_at INTEGER NOT NULL)'),
    db.prepare(`CREATE TABLE IF NOT EXISTS tiktok_jobs(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,brand_id TEXT NOT NULL,post_id TEXT NOT NULL,account_id TEXT NOT NULL,open_id TEXT NOT NULL,nickname TEXT NOT NULL,media_url TEXT NOT NULL,options TEXT NOT NULL,is_aigc INTEGER NOT NULL,scheduled_at TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'queued',publish_id TEXT,media_token TEXT UNIQUE,media_expires INTEGER,lease_until INTEGER NOT NULL DEFAULT 0,error TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,UNIQUE(owner_id,post_id,open_id))`),
    db.prepare("CREATE TABLE IF NOT EXISTS tiktok_worker(id TEXT PRIMARY KEY,claim_id TEXT,lease_until INTEGER NOT NULL DEFAULT 0)"),
  ]);
}
export class TikTokRejected extends Error {}
export async function tiktokApi<T>(path:string,token:string,body:unknown):Promise<T> {
  const response=await fetch(`https://open.tiktokapis.com/v2/${path}`,{method:'POST',signal:AbortSignal.timeout(20_000),headers:{Authorization:`Bearer ${token}`,'content-type':'application/json; charset=UTF-8'},body:JSON.stringify(body)});
  const result=await response.json() as {data?:T;error?:{code?:string}};
  const code=result.error?.code;
  if(code && code!=='ok' && response.status<500) throw new TikTokRejected(tiktokError(code));
  if(!response.ok || code!=='ok' || !result.data) throw new Error(tiktokError(code));
  return result.data;
}
export function tiktokError(code?:string) {
  const messages:Record<string,string>={unaudited_client_can_only_post_to_private_accounts:'TikTok aún no aprobó la publicación pública de esta app. En pruebas exige cuenta privada y visibilidad Solo yo.',url_ownership_unverified:'Verifica en TikTok for Developers el dominio de las imágenes antes de publicar.',scope_not_authorized:'Reconecta TikTok y autoriza el permiso video.publish.',access_token_invalid:'El acceso a TikTok venció. Reconecta la cuenta.',privacy_level_option_mismatch:'La privacidad de esta cuenta cambió. Revisa la publicación en TikTok.',spam_risk_too_many_posts:'TikTok alcanzó el límite diario de publicaciones.',spam_risk_user_banned_from_posting:'TikTok no permite publicar a esta cuenta en este momento.'};
  return messages[code??'']||'TikTok no confirmó la operación. Revisa los permisos y el estado de la cuenta.';
}
export type TikTokAccount={id:string;owner_id:string;brand_id:string;open_id:string;nickname:string;encrypted_access:string;encrypted_refresh:string;access_expires:number;refresh_expires:number;scopes:string;active:number};
export type TikTokToken={access_token:string;refresh_token:string;expires_in:number;refresh_expires_in:number;open_id:string;scope:string};
export async function requestTikTokToken(params:Record<string,string>):Promise<TikTokToken> {
  const response=await fetch('https://open.tiktokapis.com/v2/oauth/token/',{method:'POST',signal:AbortSignal.timeout(20_000),headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_key:process.env.TIKTOK_CLIENT_KEY||'',client_secret:process.env.TIKTOK_CLIENT_SECRET||'',...params})});
  const result=await response.json() as TikTokToken&{error?:string};
  if(!response.ok || result.error || !result.access_token || !result.refresh_token || !result.open_id || !(result.expires_in>0) || !(result.refresh_expires_in>0)) throw new Error('No se pudo renovar el acceso a TikTok. Reconecta esta cuenta.');
  return result;
}
export async function tiktokAccess(db:D1Database,account:TikTokAccount) {
  if(!account.active || !account.scopes.split(',').includes('video.publish')) throw new Error('Conecta TikTok con el permiso de publicación.');
  if(account.access_expires>Date.now()+120_000) return decryptInstagramToken(account.encrypted_access);
  if(account.refresh_expires<=Date.now()) throw new Error('La autorización de TikTok venció. Reconecta la cuenta.');
  const token=await requestTikTokToken({grant_type:'refresh_token',refresh_token:await decryptInstagramToken(account.encrypted_refresh)});
  if(token.open_id!==account.open_id) throw new Error('TikTok devolvió una cuenta diferente. Reconecta la marca.');
  const result=await db.prepare('UPDATE tiktok_accounts SET encrypted_access=?,encrypted_refresh=?,access_expires=?,refresh_expires=?,scopes=?,updated_at=? WHERE id=? AND owner_id=? AND active=1 AND encrypted_refresh=? RETURNING id')
    .bind(await encryptInstagramToken(token.access_token),await encryptInstagramToken(token.refresh_token),Date.now()+token.expires_in*1000,Date.now()+token.refresh_expires_in*1000,token.scope,Date.now(),account.id,account.owner_id,account.encrypted_refresh).first();
  if(!result) throw new Error('La conexión de TikTok cambió. Actualiza la página.');
  return token.access_token;
}
export async function tiktokCreator(db:D1Database,account:TikTokAccount) {return tiktokApi<TikTokCreator>('post/publish/creator_info/query/',await tiktokAccess(db,account),{});}
export async function tiktokAccount(db:D1Database,owner:string,brandId:string) {return db.prepare('SELECT * FROM tiktok_accounts WHERE owner_id=? AND brand_id=? AND active=1').bind(owner,brandId).first<TikTokAccount>();}
export async function tiktokDb() {if(!env.DB) throw new Error('El calendario no está disponible.');await ensureTikTok(env.DB);return env.DB;}
