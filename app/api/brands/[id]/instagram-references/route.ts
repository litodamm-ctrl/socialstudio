import { env } from "@/lib/runtime";
import { loadInstagramBrandMaterials } from "@/lib/instagram-brand-materials";
export async function GET(request: Request, context: { params: Promise<{id:string}> }) {
  const owner = request.headers.get("oai-authenticated-user-id");
  if (!owner) return Response.json({error:"Inicia sesión."},{status:401});
  if (!env.DB) return Response.json({error:"Base de datos no disponible."},{status:503});
  const {id} = await context.params;
  const brand = await env.DB.prepare("SELECT name FROM brand_registry WHERE owner_id = ? AND id = ? AND active = 1").bind(owner,id).first<{name:string}>();
  if (!brand) return Response.json({error:"Marca no disponible."},{status:404});
  try {
    const result = await loadInstagramBrandMaterials(env.DB,owner,brand.name,`${brand.name}:preview`);
    return Response.json({username:result.username,postsRead:result.postsRead,images:result.content.filter(item=>item.type==='input_image').map(item=>item.image_url),captions:result.text},{headers:{"Cache-Control":"private, no-store"}});
  } catch (error) { return Response.json({error:error instanceof Error ? error.message : "No se pudieron leer las referencias."},{status:422}); }
}
