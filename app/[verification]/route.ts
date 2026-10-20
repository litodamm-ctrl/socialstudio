export async function GET(_request:Request,context:{params:Promise<{verification:string}>}) {
 const {verification}=await context.params;
 if(!/^tiktok[A-Za-z0-9_-]+\.txt$/.test(verification)||verification!==process.env.TIKTOK_VERIFICATION_FILE||!process.env.TIKTOK_VERIFICATION_CONTENT)return new Response('Not found',{status:404});
 return new Response(process.env.TIKTOK_VERIFICATION_CONTENT,{headers:{'content-type':'text/plain; charset=utf-8','cache-control':'no-store'}});
}
