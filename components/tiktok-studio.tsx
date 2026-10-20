'use client';
import Image from 'next/image';
import {useCallback,useEffect,useState} from 'react';
import type {TikTokCreator} from '@/lib/tiktok-policy';
import styles from './tiktok-studio.module.css';
type Brand={id:string;name:string};
type Post={id:string;brand:string;caption:string;mediaType:string;mediaUrl:string;scheduledAt:string|null};
type Account={brand_id:string;nickname:string};
type Job={id:string;brand_id:string;post_id:string;nickname:string;scheduled_at:string;status:string;error?:string};
type ApiResponse={error?:string;accounts?:Account[];jobs?:Job[];missing?:string[];audited?:boolean;domainVerified?:boolean;creator?:TikTokCreator};
const labels:Record<string,string>={PUBLIC_TO_EVERYONE:'Todo el mundo',MUTUAL_FOLLOW_FRIENDS:'Amigos',FOLLOWER_OF_CREATOR:'Seguidores',SELF_ONLY:'Solo yo'};
const statusLabels:Record<string,string>={queued:'Programado',sending:'Enviando a TikTok',processing:'TikTok está procesando',published:'Publicado en TikTok',failed:'Requiere revisión',uncertain:'Comprueba TikTok antes de reenviar',cancelled:'Cancelado'};
function localDate(value:string) {const p=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:'America/Bogota',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date(value)).map(v=>[v.type,v.value]));return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;}
function suggestedDate(value:string|null) {return localDate(value&&Date.parse(value)>Date.now()+60_000?value:new Date(Date.now()+600_000).toISOString());}
export default function TikTokStudio({brands,posts,initialBrandId,initialPostId}:{brands:Brand[];posts:Post[];initialBrandId?:string;initialPostId?:string}) {
 const [brandId,setBrandId]=useState(initialBrandId||brands.find(b=>!b.id.startsWith('seed-'))?.id||'');
 const [accounts,setAccounts]=useState<Account[]>([]);const [missing,setMissing]=useState<string[]>([]);const [audited,setAudited]=useState(false);const [domainVerified,setDomainVerified]=useState(false);
 const [jobs,setJobs]=useState<Job[]>([]);const [postId,setPostId]=useState(initialPostId||'');const [creator,setCreator]=useState<TikTokCreator|null>(null);
 const [title,setTitle]=useState('');const [description,setDescription]=useState('');const [privacy,setPrivacy]=useState('');const [comments,setComments]=useState(false);
 const [commercial,setCommercial]=useState(false);const [ownBrand,setOwnBrand]=useState(false);const [paid,setPaid]=useState(false);const [consent,setConsent]=useState(false);const [aigc,setAigc]=useState(false);
 const [date,setDate]=useState(()=>localDate(new Date(Date.now()+10*60000).toISOString()));const [busy,setBusy]=useState(false);const [loaded,setLoaded]=useState(false);const [message,setMessage]=useState('');
 useEffect(()=>{if(!brands.some(b=>b.id===brandId&&!b.id.startsWith('seed-'))){const task=window.setTimeout(()=>setBrandId(brands.find(b=>!b.id.startsWith('seed-'))?.id||''),0);return()=>window.clearTimeout(task);}},[brands,brandId]);
 const brand=brands.find(b=>b.id===brandId);const account=accounts.find(a=>a.brand_id===brandId);const choices=posts.filter(p=>p.brand===brand?.name&&p.mediaType==='Imagen'&&p.mediaUrl);const post=choices.find(p=>p.id===postId);
 const reload=useCallback(async () => {
  const responses=await Promise.all([fetch('/api/tiktok/accounts',{cache:'no-store'}),fetch('/api/tiktok/jobs',{cache:'no-store'})]);
  const [a,j]=await Promise.all(responses.map(async r=>await r.json() as ApiResponse));
  if(!responses[0].ok||!responses[1].ok)throw new Error(a.error||j.error||'No se pudo consultar TikTok.');
  setAccounts(a.accounts||[]);setMissing(a.missing||[]);setAudited(Boolean(a.audited));setDomainVerified(Boolean(a.domainVerified));setJobs(j.jobs||[]);setLoaded(true);
 },[]);
 useEffect(()=>{const task=window.setTimeout(()=>{void reload().catch(e=>setMessage(e.message));const result=new URLSearchParams(window.location.search).get('tiktok');const texts:Record<string,string>={connected:'Cuenta TikTok conectada. Ya puedes preparar una publicación.',missing_config:'Falta configurar la app de TikTok en Netlify.',cancelled:'La conexión fue cancelada.',invalid_state:'La conexión venció. Intenta conectar de nuevo.',connection_error:'TikTok no pudo conectar. Revisa las credenciales, el callback y los permisos.',missing_scope:'Autoriza el permiso video.publish al conectar TikTok.',account_conflict:'Esta cuenta pertenece a otra marca o debes desconectar la cuenta anterior antes de cambiarla.'};if(result)setMessage(texts[result]||'Revisa la conexión TikTok.');},0);return()=>window.clearTimeout(task);},[reload]);
 function choosePost(id:string) {const p=choices.find(item=>item.id===id);setPostId(id);setCreator(null);setPrivacy('');setComments(false);setConsent(false);setCommercial(false);setOwnBrand(false);setPaid(false);setAigc(false);setTitle(brand?.name||'');setDescription(p?.caption||'');setDate(suggestedDate(p?.scheduledAt??null));}
 async function prepare() {
  if(!post)return;setBusy(true);setMessage('');setCreator(null);setPrivacy('');setComments(false);setConsent(false);
  try{const response=await fetch(`/api/tiktok/creator?brandId=${encodeURIComponent(brandId)}`,{cache:'no-store'});const data=await response.json() as ApiResponse;if(!response.ok)throw new Error(data.error);if(!data.creator)throw new Error("TikTok no devolvió la cuenta.");setCreator(data.creator);setAudited(Boolean(data.audited));if(!title)setTitle(brand?.name||'');if(!description)setDescription(post.caption);}catch(e){setMessage(e instanceof Error?e.message:'No se pudo consultar TikTok.');}finally{setBusy(false);}
 }
 async function disconnect() {
  setBusy(true);setMessage('');try{const response=await fetch('/api/tiktok/accounts',{method:'DELETE',headers:{'content-type':'application/json'},body:JSON.stringify({brandId})});const data=await response.json() as ApiResponse;if(!response.ok)throw new Error(data.error);setCreator(null);await reload();setMessage('TikTok desconectado. Sus publicaciones pendientes fueron canceladas.');}catch(e){setMessage(e instanceof Error?e.message:'No se pudo desconectar.');}finally{setBusy(false);}
 }
 async function submit() {
  setBusy(true);setMessage('');try{const response=await fetch('/api/tiktok/jobs',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({brandId,postId,title,description,privacy,allowComments:comments,commercial,ownBrand,paidPartnership:paid,consent,isAigc:aigc,scheduledAt:new Date(`${date}:00-05:00`).toISOString()})});const data=await response.json() as ApiResponse;if(!response.ok)throw new Error(data.error);setConsent(false);setCreator(null);await reload();setMessage('Foto programada para TikTok. Puede tardar unos minutos en procesarse y aparecer en el perfil.');}catch(e){setMessage(e instanceof Error?e.message:'No se pudo programar.');}finally{setBusy(false);}
 }
 async function cancel(id:string) {setBusy(true);try{const response=await fetch('/api/tiktok/jobs',{method:'DELETE',headers:{'content-type':'application/json'},body:JSON.stringify({id})});const data=await response.json() as ApiResponse;if(!response.ok)throw new Error(data.error);await reload();setMessage('Programación TikTok cancelada.');}catch(e){setMessage(e instanceof Error?e.message:'No se pudo cancelar.');}finally{setBusy(false);}}
 return <section className={styles.studio} aria-label="TikTok por marca">
  <p className={styles.hint}>Publica fotos del feed en la cuenta TikTok de cada marca. Revisa cada pieza y elige su privacidad antes de programarla.</p>
  <label>Marca<select value={brandId} disabled={busy} onChange={e=>{setBrandId(e.target.value);setPostId('');setCreator(null);setPrivacy('');setConsent(false);setMessage('');}}>{brands.filter(b=>!b.id.startsWith('seed-')).map(b=><option key={b.id} value={b.id}>{b.name}</option>)}</select></label>
  <div className={styles.box}><h3>{account?`Conectada: ${account.nickname}`:'Conectar TikTok'}</h3>
   {missing.length>0&&<p className={styles.error}>Configuración pendiente: {missing.join(', ')}. Registra el callback <code>https://socialstudioig.netlify.app/api/tiktok/callback</code> en Login Kit y habilita Content Posting API.</p>}
   {account?<button type="button" className="secondary-button" disabled={busy} onClick={()=>void disconnect()}>Desconectar TikTok</button>:<button type="button" className="primary-button" disabled={!loaded||busy||missing.length>0||!brand} onClick={()=>window.location.assign(new URL(`/api/tiktok/connect?brandId=${encodeURIComponent(brandId)}`,window.location.origin).href)}>Conectar TikTok de {brand?.name}</button>}
   {!audited&&<p className={styles.hint}>Publicación pública pendiente de aprobación de TikTok. Antes de la auditoría solo se permite “Solo yo” con una cuenta privada.</p>}
   {!domainVerified&&<p className={styles.hint}>Falta verificar en TikTok for Developers el dominio desde el que se descargan las fotos.</p>}
  </div>
  {message&&<p className={styles.error} role="status">{message}</p>}
  {account&&<div className={styles.box}><h3>Preparar una foto para el feed</h3><label>Publicación<select value={postId} disabled={busy} onChange={e=>choosePost(e.target.value)}><option value="">Selecciona una foto</option>{choices.map(p=><option key={p.id} value={p.id}>{p.scheduledAt?new Date(p.scheduledAt).toLocaleDateString('es-CO',{timeZone:'America/Bogota'}):'Borrador'} · {p.caption.slice(0,75)}</option>)}</select></label>
   {post&&<><Image unoptimized width={1080} height={1080} className={styles.preview} src={post.mediaUrl} alt={`Vista previa de ${post.brand} para TikTok`}/><button type="button" className="secondary-button" disabled={busy} onClick={()=>void prepare()}>Consultar cuenta y revisar publicación</button></>}
   {creator&&post&&<><strong>Se publicará en: {creator.creator_nickname||account.nickname}{creator.creator_username?` (@${creator.creator_username})`:''}</strong>
    <label>Título<input value={title} maxLength={90} onChange={e=>{setTitle(e.target.value);setConsent(false);}}/></label>
    <label>Descripción<textarea value={description} maxLength={4000} onChange={e=>{setDescription(e.target.value);setConsent(false);}}/></label>
    <label>Privacidad<select value={privacy} onChange={e=>{setPrivacy(e.target.value);setConsent(false);}}><option value="">Elige quién puede verlo</option>{creator.privacy_level_options.map(option=><option key={option} value={option} disabled={(!audited&&option!=='SELF_ONLY')||(paid&&option==='SELF_ONLY')}>{labels[option]||option}</option>)}</select></label>
    <label className={styles.check}><input type="checkbox" checked={comments} disabled={creator.comment_disabled} onChange={e=>{setComments(e.target.checked);setConsent(false);}}/>Permitir comentarios{creator.comment_disabled?' (deshabilitados por la cuenta)':''}</label>
    <label className={styles.check}><input type="checkbox" checked={commercial} onChange={e=>{setCommercial(e.target.checked);setOwnBrand(false);setPaid(false);setConsent(false);}}/>Este contenido promueve una marca, producto o servicio</label>
    {commercial&&<><label className={styles.check}><input type="checkbox" checked={ownBrand} onChange={e=>{setOwnBrand(e.target.checked);setConsent(false);}}/>Mi propia marca</label><label className={styles.check}><input type="checkbox" checked={paid} disabled={privacy==='SELF_ONLY'} onChange={e=>{setPaid(e.target.checked);setConsent(false);}}/>Colaboración pagada con otra marca</label><p className={styles.hint}>{paid?'La publicación llevará la etiqueta de colaboración pagada.':ownBrand?'La publicación llevará la etiqueta de contenido promocional.':'Selecciona tu marca, una colaboración pagada o ambas.'} La colaboración pagada no puede tener visibilidad “Solo yo”.</p></>}
    <label className={styles.check}><input type="checkbox" checked={aigc} onChange={e=>{setAigc(e.target.checked);setConsent(false);}}/>Marcar como contenido generado o editado con IA</label><p className={styles.hint}>Las imágenes creadas por el agente se etiquetan automáticamente como IA.</p>
    <label>Fecha y hora · Bogotá<input type="datetime-local" value={date} onChange={e=>{setDate(e.target.value);setConsent(false);}}/></label>
    <label className={styles.check}><input type="checkbox" checked={consent} onChange={e=>setConsent(e.target.checked)}/><span>Revisé la foto, la cuenta, el texto y la privacidad. Autorizo su envío programado y acepto la <a href="https://www.tiktok.com/legal/page/global/music-usage-confirmation/en" target="_blank" rel="noreferrer">confirmación de uso de música de TikTok</a>{paid&&<> y la <a href="https://www.tiktok.com/legal/page/global/bc-policy/en" target="_blank" rel="noreferrer">política de contenido de marca</a></>}. No se añadirá música automáticamente.</span></label>
    <button type="button" className="primary-button" disabled={busy||!consent||!privacy||!title.trim()||!domainVerified||(commercial&&!ownBrand&&!paid)} onClick={()=>void submit()}>Programar foto en TikTok</button>
   </>}
  </div>}
  <div className={styles.box}><div className={styles.row}><h3>Cola TikTok</h3><button type="button" className="secondary-button" disabled={busy} onClick={()=>void reload().catch(e=>setMessage(e.message))}>Actualizar TikTok</button></div>
   {!jobs.some(j=>j.brand_id===brandId)&&<p className={styles.hint}>Aún no hay publicaciones TikTok para esta marca.</p>}
   {jobs.filter(j=>j.brand_id===brandId).map(job=><article className={styles.job} key={job.id}><strong>{statusLabels[job.status]||job.status} · {job.nickname}</strong><span className={styles.hint}>{new Date(job.scheduled_at).toLocaleString('es-CO',{timeZone:'America/Bogota'})} · Bogotá</span>{job.error&&<span className={styles.error}>{job.error}</span>}{job.status==='queued'&&<button type="button" className="secondary-button" disabled={busy} onClick={()=>void cancel(job.id)}>Cancelar publicación TikTok</button>}</article>)}
  </div>
 </section>;
}
