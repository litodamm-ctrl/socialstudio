# SEO y Google en Social Studio

## Operación

La pestaña reutiliza las marcas, su esencia y hasta diez webs. Cada agente revisa diariamente o semanalmente las URLs guardadas y consulta las fuentes de Google vinculadas. `seo-schedule` activa el trabajo cada treinta minutos; `seo-background` procesa auditorías y envíos sin bloquear la app. La frecuencia se cuenta desde el inicio de la última auditoría. El cron de publicaciones de Instagram no se modifica.

El informe conserva evidencia, errores por fuente, un puntaje interno y hasta treinta consultas de Search Console del periodo de veintiocho días que termina tres días antes. El puntaje no mide posiciones ni confirma indexación. Se revisan títulos, descripciones, H1, canonical, alt, viewport, idioma, noindex en HTML y X-Robots-Tag, y sintaxis/forma básica de JSON-LD. No incluye renderizado JavaScript, rastreo completo, PageSpeed, enlaces rotos ni validación semántica completa de Schema.org.

El agente recibe texto público limitado de cada URL y los datos de la marca. Produce un plan breve y propuestas estructuradas. No se aceptan propuestas para páginas que no se leyeron ni para una ficha que Google no devolvió. Una respuesta IA incompleta se muestra como fallo de generación, conservando la auditoría.

## Mejoras editables y ejecución

Las propuestas guardan texto anterior, texto propuesto, fecha, marca, auditoría, destino y estado. Los borradores pueden editarse y copiarse. Los cambios externos se ejecutan en segundo plano y se distinguen de la auditoría:

- **GitHub:** crea una rama y una solicitud de cambios para título y descripción. No fusiona ni publica directamente. Se puede habilitar la creación automática de propuestas después de cada auditoría, por marca. La rama base queda intacta. Después de aceptar y desplegar el cambio, «Verificar en la web» comprueba que el HTML público contiene los textos exactos.
- **Google Business:** envía únicamente `profile.description`, tras una acción explícita sobre la propuesta. Comprueba la descripción actual contra la registrada, rechaza cambios ajenos y confirma el valor mediante lectura posterior. La aceptación de la API no confirma visibilidad pública. Se puede restaurar la descripción anterior mediante otra acción registrada.
- **Shopify:** los textos pueden copiarse al editor SEO de Shopify. Esta versión no instala una conexión de escritura con Shopify ni modifica su tema o catálogo.

Los envíos se reclaman atómicamente. Las propuestas no cambian de propietario ni de destino durante un reintento. Hay exclusión por recurso externo entre marcas, identificador por intento y rechazo de propuestas con más de siete días. Una entrega incierta conserva su texto/destino para reconciliar el resultado antes de reintentar. Archivar mueve una propuesta al historial de la app: no cierra una solicitud en GitHub ni revierte cambios externos.

## Preparación de servicios

Conservar Cloudflare D1 y las variables existentes:

- `SITE_ORIGIN=https://socialstudioig.netlify.app`
- `CRON_SECRET` para las funciones de Netlify.
- `OPENAI_API_KEY`; `SEO_AGENT_MODEL` es opcional y conserva el modelo de texto usado por el proyecto.
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `INSTAGRAM_TOKEN_ENCRYPTION_KEY` (clave base64 de 32 bytes para cifrar el token).
- URI de redirección autorizada: `https://socialstudioig.netlify.app/api/seo/google`. Mantener también los callbacks existentes de Drive/Instagram.

Habilitar Search Console API, My Business Account Management API y My Business Business Information API. Google Business necesita aprobación del proyecto y cuota; habilitar la API y autorizar OAuth no concede esa aprobación. Con cuota cero, solicitar Basic API Access. La ficha usada para la solicitud debe cumplir los requisitos oficiales, incluida verificación y actividad de al menos sesenta días.

En Google Auth Platform, revisar el estado de publicación de OAuth. Los tokens de una aplicación externa en modo Testing con estos permisos pueden caducar; completar la configuración de producción/verificación que Google solicite. No se intenta eludir este requisito.

La app muestra por separado errores de cuota, API deshabilitada, permiso OAuth y acceso a una propiedad de Search Console. Las propiedades marcadas por Google como `siteUnverifiedUser` no pueden seleccionarse como una conexión operativa. Listar una propiedad no prueba que se puedan leer sus métricas.

## GitHub

Configurar `SEO_GITHUB_TOKEN` como variable secreta en Netlify, ámbito **Functions**, con acceso limitado a los repositorios de las webs y permisos **Contents: Read and write** y **Pull requests: Read and write**. No se solicita ni guarda el token en el navegador. El conector de GitHub de ChatGPT no transfiere automáticamente su autorización al servidor de Social Studio.

En «Destinos de las mejoras», guardar por URL su repositorio, rama y archivo fuente. La UI no infiere repositorios. Se admiten HTML estático y metadatos estáticos en las rutas raíz de Next documentadas por el formulario. Las expresiones dinámicas, fuentes ambiguas y cambios desde la auditoría se rechazan para revisar el destino. Las credenciales y rutas arbitrarias nunca proceden del modelo.

Repositorios identificados a partir de los despliegues de Netlify:

| Web | Repositorio | Fuente a comprobar |
| --- | --- | --- |
| bahiapadel.com | litodamm-ctrl/bahiapadel.com | index.html |
| dneylacentrohistorico.com | litodamm-ctrl/dneyla | index.html |
| manglarcol.com | litodamm-ctrl/manglar | index.html |
| grandbaybaru.netlify.app | litodamm-ctrl/grandbay | index.html |
| veranorte.netlify.app | litodamm-ctrl/VERANORTE | index.html |
| santillanadelmar1.netlify.app | litodamm-ctrl/santillana | index.html |
| altorena.netlify.app | litodamm-ctrl/altorena | app/layout.tsx |

Comprobar que el archivo fuente corresponde al HTML publicado, especialmente si existe un generador de SEO. El conector compara con la evidencia anterior; no modifica un generador ni ignora diferencias entre el repositorio y la web.

## Datos y conexiones

Las tablas `seo_delivery`, `seo_proposals`, `seo_resource_leases` y `seo_google_capabilities` se crean de forma aditiva. No se alteran las publicaciones ni las tablas de medios existentes. La última guarda los permisos y la caducidad del token de renovación cuando Google los devuelve; las conexiones antiguas siguen funcionando sin inventar un vencimiento.

La conexión Google pertenece al propietario del espacio y sus recursos se seleccionan por marca. Desconectar borra el token local y los vínculos de todas las marcas. Conserva informes e historial previos y no revoca permisos de otras integraciones.

## Verificación

- `node --test lib/seo*.test.mjs lib/website-sources.test.mjs lib/website-diagnostics.test.mjs lib/website-size.test.mjs`
- `node node_modules/typescript/bin/tsc --noEmit`
- `npm run build`

Las pruebas de los conectores usan proveedores simulados para cubrir identidad de recurso, límites, concurrencia, conflictos, idempotencia y errores sin publicar en cuentas reales. La comprobación de producción debe incluir una auditoría con HTML, plan IA y datos de Google disponibles. Una función aceptada con HTTP 202 no equivale a un informe completado ni a un cambio publicado.
