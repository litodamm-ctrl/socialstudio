# TikTok: fotos en el feed

Social Studio permite conectar una cuenta de TikTok por marca y preparar una foto JPG de una publicación existente. El usuario revisa el contenido, edita título y descripción, consulta la cuenta actual, elige privacidad e interacciones, declara contenido comercial y confirma el envío antes de programarlo. El piloto de Instagram no envía automáticamente piezas a TikTok sin esa revisión.

## Activación

1. En https://developers.tiktok.com registra una app con Login Kit para web y Content Posting API / Direct Post. Solicita `user.info.basic` y `video.publish`.
2. Registra exactamente el callback `https://socialstudioig.netlify.app/api/tiktok/callback`.
3. En Netlify, variables de entorno con alcance Functions y contexto Production:
   - `TIKTOK_CLIENT_KEY`: Client key de la app.
   - `TIKTOK_CLIENT_SECRET`: Client secret, secreto del servidor.
   - `SITE_ORIGIN`: `https://socialstudioig.netlify.app` (ya utilizado por Social Studio).
   - `INSTAGRAM_TOKEN_ENCRYPTION_KEY`: clave AES existente; también protege los tokens de TikTok. No cambiarla para activar esta integración.
4. Verifica la propiedad del dominio/prefijo de descarga en Manage URL properties de TikTok. Las imágenes se entregan directamente desde `https://socialstudioig.netlify.app/api/tiktok/media/`, sin redirección a R2.
   Si TikTok proporciona un archivo `tiktok…txt`, configura `TIKTOK_VERIFICATION_FILE` con su nombre exacto y `TIKTOK_VERIFICATION_CONTENT` con su contenido exacto. Después del despliegue, el archivo estará disponible públicamente solo en esa ruta. Estas variables no son Client Secret.
5. Solo después de completar la verificación oficial, establece `TIKTOK_MEDIA_DOMAIN_VERIFIED=true` y vuelve a desplegar.
6. El modo de pruebas está activo por defecto: cuenta TikTok privada y privacidad “Solo yo”. Solo cuando TikTok apruebe la auditoría Direct Post se establece `TIKTOK_DIRECT_POST_APPROVED=true`. No usar la variable para eludir la revisión del proveedor.
7. En Social Studio: TikTok · Feed → marca → Conectar TikTok. Cada propietario autoriza su propia cuenta en TikTok. No se solicita su contraseña en Social Studio.

## Límites de aprobación

TikTok exige una auditoría para publicación pública. Sus Content Sharing Guidelines indican que las herramientas limitadas a uso interno/privado del propio equipo no son elegibles para Direct Post; la aprobación de una plataforma para una audiencia amplia depende de TikTok. Implementar OAuth no garantiza dicha aprobación. Si la modalidad de negocio no es elegible, será necesario un proveedor de publicación aprobado o completar las publicaciones en TikTok mediante otra integración permitida; no se deben ocultar estos límites ni marcar la app como aprobada sin autorización.

Esta versión publica fotos individuales en el feed; no incluye videos ni historias. Las fotos del agente se etiquetan como IA. No se añade música automáticamente.

## Programación y seguridad

- La cola TikTok es independiente de Instagram/Facebook. Crear o cancelar una programación TikTok no cancela otra red.
- El cron existente llama al publicador cada minuto. Los tokens se renuevan con el refresh token cifrado antes de vencer. Se actualizan los refresh tokens devueltos por TikTok.
- La cuenta se vincula al propietario y a la marca. El callback consume un estado de un solo uso, asociado a la sesión.
- Solo la foto expresamente aprobada se entrega mediante un token aleatorio de 48 bytes. La ruta deja de servirla al terminar, cancelar o vencer la autorización. La verificación de dominio no expone la biblioteca.
- La cola guarda el contenido aprobado. Si la foto original se modifica/elimina, o se desconecta la marca/cuenta, el publicador detiene el envío. Cada inicio se bloquea contra cron concurrente.
- Una respuesta incierta tras iniciar una publicación no se reenvía automáticamente. El usuario debe comprobar TikTok. Los rechazos definitivos y las cancelaciones pueden prepararse de nuevo con consentimiento actualizado.
- La app consulta el estado de TikTok y solo muestra “Publicado” al recibir `PUBLISH_COMPLETE`. Puede tardar varios minutos en aparecer.

Documentación oficial:
- https://developers.tiktok.com/docs/en/login-kit-web
- https://developers.tiktok.com/docs/en/content-posting-api-reference-photo-post
- https://developers.tiktok.com/docs/en/content-sharing-guidelines
- https://developers.tiktok.com/docs/en/oauth-user-access-token-management
