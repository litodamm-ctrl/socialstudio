export type TikTokCreator = {creator_nickname?:string;creator_username?:string;privacy_level_options:string[];comment_disabled:boolean};
export type TikTokPostOptions = {title:string;description:string;privacy:string;allowComments:boolean;commercial:boolean;ownBrand:boolean;paidPartnership:boolean;consent:boolean;scheduledAt:string};
export function validateTikTokPost(raw:Record<string,unknown>,creator:TikTokCreator,audited:boolean,now=Date.now()):TikTokPostOptions {
  if(raw.consent!==true) throw new Error('Confirma el consentimiento de publicación y uso de música de TikTok.');
  if(typeof raw.privacy!=='string' || !creator.privacy_level_options.includes(raw.privacy)) throw new Error('Selecciona una privacidad disponible para esta cuenta.');
  if(!audited && raw.privacy!=='SELF_ONLY') throw new Error('TikTok requiere la auditoría de Direct Post para publicar de forma pública.');
  const title=typeof raw.title==='string'?raw.title.trim():'';
  const description=typeof raw.description==='string'?raw.description.trim():'';
  if(!title || title.length>90 || description.length>4000) throw new Error('El título admite 90 caracteres y la descripción 4.000.');
  if(raw.allowComments===true && creator.comment_disabled) throw new Error('Esta cuenta no permite comentarios.');
  if(raw.commercial===true && raw.ownBrand!==true && raw.paidPartnership!==true) throw new Error('Selecciona qué tipo de contenido comercial vas a publicar.');
  if(raw.commercial===true && raw.paidPartnership===true && raw.privacy==='SELF_ONLY') throw new Error('Una colaboración pagada no puede ser privada.');
  const scheduledAt=typeof raw.scheduledAt==='string'?raw.scheduledAt:'';
  const time=Date.parse(scheduledAt);
  if(!Number.isFinite(time) || time<now+60_000 || time>now+31*86400_000) throw new Error('Elige una fecha futura, entre un minuto y 31 días.');
  return {title,description,privacy:raw.privacy,allowComments:raw.allowComments===true,commercial:raw.commercial===true,ownBrand:raw.commercial===true&&raw.ownBrand===true,paidPartnership:raw.commercial===true&&raw.paidPartnership===true,consent:true,scheduledAt:new Date(time).toISOString()};
}
export function photoPostBody(options:TikTokPostOptions,url:string,isAigc:boolean) {
  return {media_type:'PHOTO',post_mode:'DIRECT_POST',is_aigc:isAigc,post_info:{title:options.title,description:options.description,privacy_level:options.privacy,disable_comment:!options.allowComments,auto_add_music:false,brand_content_toggle:options.paidPartnership,brand_organic_toggle:options.ownBrand},source_info:{source:'PULL_FROM_URL',photo_cover_index:0,photo_images:[url]}};
}
