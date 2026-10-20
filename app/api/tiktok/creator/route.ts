import {tiktokDb,tiktokAccount,tiktokCreator,tiktokAudited} from '@/lib/tiktok';
export async function GET(request:Request) {
 const owner=request.headers.get('oai-authenticated-user-id');if(!owner)return Response.json({error:'Inicia sesión.'},{status:401});
 try{const db=await tiktokDb();const account=await tiktokAccount(db,owner,new URL(request.url).searchParams.get('brandId')||'');
 if(!account)return Response.json({error:'Conecta la cuenta de TikTok de esta marca.'},{status:409});
 return Response.json({creator:await tiktokCreator(db,account),audited:tiktokAudited()});
 }catch(error){return Response.json({error:error instanceof Error?error.message:'No se pudo consultar TikTok.'},{status:502});}
}
