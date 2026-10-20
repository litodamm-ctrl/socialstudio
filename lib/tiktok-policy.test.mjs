import test from 'node:test';
import assert from 'node:assert/strict';
import { validateTikTokPost, photoPostBody } from './tiktok-policy.ts';
const creator={privacy_level_options:['PUBLIC_TO_EVERYONE','SELF_ONLY'],comment_disabled:false};
const base={title:'Mi marca',description:'Mi producto',privacy:'PUBLIC_TO_EVERYONE',allowComments:true,commercial:true,ownBrand:true,paidPartnership:false,consent:true,scheduledAt:new Date(Date.now()+86400_000).toISOString()};
test('requires explicit consent, privacy and correct live creator permissions',()=>{
 assert.throws(()=>validateTikTokPost({...base,consent:false},creator,true),/consentimiento/);
 assert.throws(()=>validateTikTokPost({...base,privacy:''},creator,true),/privacidad/);
 assert.throws(()=>validateTikTokPost(base,creator,false),/auditoría/);
 assert.throws(()=>validateTikTokPost(base,{...creator,comment_disabled:true},true),/comentarios/);
 assert.throws(()=>validateTikTokPost({...base,commercial:true,ownBrand:false},creator,true),/comercial/);
 assert.throws(()=>validateTikTokPost({...base,privacy:'SELF_ONLY',paidPartnership:true},creator,true),/privada/);
 assert.throws(()=>validateTikTokPost({...base,scheduledAt:'2020-01-01'},creator,true),/futura/);
 assert.equal(validateTikTokPost(base,creator,true).privacy,'PUBLIC_TO_EVERYONE');
});
test('photo payload uses approved caption and does not assume music or privacy; generated photos are labeled',()=>{
 const input=validateTikTokPost(base,creator,true);
 const body=photoPostBody(input,'https://socialstudioig.netlify.app/api/tiktok/media/opaque',true);
 assert.equal(body.media_type,'PHOTO');assert.equal(body.post_mode,'DIRECT_POST');
 assert.equal(body.is_aigc,true);assert.equal(body.post_info.auto_add_music,false);
 assert.equal(body.post_info.privacy_level,'PUBLIC_TO_EVERYONE');
 assert.equal(body.post_info.brand_organic_toggle,true);assert.equal(body.post_info.brand_content_toggle,false);
 assert.deepEqual(body.source_info.photo_images,['https://socialstudioig.netlify.app/api/tiktok/media/opaque']);
});
