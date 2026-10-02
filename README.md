# Social Studio para Netlify

Código fuente Next.js con calendario de Instagram, publicación en Facebook autorizada por marca y agentes de contenido. Usa Cloudflare D1 y R2 para datos y archivos. No incluye credenciales.

## Instalación

1. Descomprime el ZIP. Sube el CONTENIDO de la carpeta a GitHub, dejando package.json y netlify.toml en la raíz. Guarda un commit en main.
2. En Netlify elige Add new project / Import an existing project y conecta ese repositorio. No uses Netlify Drop: esta app necesita compilación y funciones.
3. netlify.toml configura `pnpm build`, publicación `.next` y Node 22. Netlify instala automáticamente su integración Next.js.
4. Configura las variables de `.env.example` en Environment variables para producción, disponibles para Functions. No subas claves a GitHub ni expongas secretos al navegador.
5. SITE_ORIGIN debe ser el dominio definitivo, por ejemplo https://tu-sitio.netlify.app. Despliega de nuevo tras cambiar variables.
6. Abre /login e ingresa ADMIN_PASSWORD.

## Datos y archivos

Necesitas Cloudflare D1 y un bucket R2. Configura CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_D1_DATABASE_ID, CLOUDFLARE_API_TOKEN (D1 lectura/escritura), R2_BUCKET_NAME, R2_ACCESS_KEY_ID y R2_SECRET_ACCESS_KEY (R2 lectura/escritura).

Para D1 nueva, ejecuta en orden drizzle/0000_nostalgic_starjammers.sql y drizzle/0001_fearless_supreme_intelligence.sql. Las tablas adicionales se crean al usar las funciones. Para migrar los datos existentes, necesitas acceso a la base y bucket actuales, el mismo SITE_OWNER_ID y la misma INSTAGRAM_TOKEN_ENCRYPTION_KEY. El ZIP no exporta datos ni cuentas conectadas.

Configura CORS de R2 con el dominio de Netlify, métodos GET/HEAD/PUT, encabezados content-type, x-amz-meta-ownerid y x-amz-meta-brandid y expón ETag. Las cargas van directamente a R2.

## Claves y conexiones

- ADMIN_PASSWORD: contraseña privada.
- AUTH_SECRET y CRON_SECRET: valores aleatorios largos y diferentes, por ejemplo 32 bytes cada uno.
- SITE_OWNER_ID: `owner` para instalación nueva; identificador existente si migras.
- OPENAI_API_KEY: necesaria para creativos y copys; facturación de IA independiente.
- GOOGLE_CLIENT_ID y GOOGLE_CLIENT_SECRET: para carpetas privadas de Drive, opcional.
- INSTAGRAM_APP_ID, INSTAGRAM_APP_SECRET e INSTAGRAM_TOKEN_ENCRYPTION_KEY: integración Meta.

Registra los callbacks con tu dominio definitivo:

- Instagram: https://tu-sitio.netlify.app/api/meta/callback (también INSTAGRAM_REDIRECT_URI).
- Facebook: https://tu-sitio.netlify.app/api/meta/facebook/callback.
- Google: https://tu-sitio.netlify.app/api/brands/drive/callback.

Facebook requiere autorizar la Página vinculada desde la ficha de marca. Instagram Login solo no da permiso de publicación en Facebook.

## Automatización

La función `tick` corre cada minuto en producción y lanza por separado `publish-background` y `agent-background`. Publicar y generar no se bloquean entre sí.

En Marcas, completa la esencia, adjunta materiales o conecta Drive, vincula Instagram y Facebook, activa replicar a Facebook y guarda Piloto automático. La configuración inicial propone todos los días: historia de imagen a las 09:00 y feed a las 18:00, hora de Colombia. Cada marca puede cambiar horarios y días.

El primer ciclo comienza al día siguiente de activar el piloto y abarca 15 días completos. El siguiente se prepara dos días antes de acabar el actual; no necesitas abrir la app. Con todos los días activos se crean 15 feeds y 15 historias por ciclo. La preparación es progresiva, no instantánea: una generación simultánea en todo el sitio, máximo tres intentos por pieza. Cada intento puede consumir API, incluso si falla. Para detener futuros gastos, pausa el piloto; una generación ya iniciada puede terminar.

Los ciclos y espacios se guardan en D1. Los trabajos terminados no se regeneran al cancelar, borrar o editar una publicación. Una publicación manual existente ocupa su formato/día. Pausar el piloto o archivar la marca detiene la publicación automática pendiente; las publicaciones manuales conservan su agenda. Un envío ya aceptado por Meta no se puede detener. Al reanudar no se envían automáticamente piezas vencidas hace más de 24 horas. Cambiar horarios/días afecta al siguiente ciclo; edita individualmente las piezas ya preparadas.

La pantalla de marca muestra fechas, progreso y errores. Historias automáticas: imágenes JPG verticales, con mensaje integrado en la imagen. No se generan videos, encuestas ni stickers interactivos. Facebook usa su propia API; requiere una Página autorizada y replicación activada. Si falla Instagram, no se cruza esa pieza a Facebook. Los envíos finales ambiguos se dejan para revisión manual, evitando duplicados.

Las referencias se rotan por fecha: hasta 100 archivos adjuntos y 300 archivos de la carpeta directa de Drive (sin subcarpetas). Se usan JPG/PNG/WebP, PDF, texto y documentos compatibles; los videos no se analizan. Los textos recientes ayudan a variar los temas. Las instrucciones limitan datos inventados y promociones vencidas, pero la calidad factual de IA requiere materiales actualizados; no hay verificación humana obligatoria.

Crear con agente inicia `creative-background`, guarda el resultado en D1 y la pantalla consulta el progreso. Esto evita peticiones síncronas largas. Las tareas internas exigen CRON_SECRET; nunca uses un nombre NEXT_PUBLIC_ para secretos.

Las funciones programadas solo corren en producción. Las funciones de segundo plano deben estar disponibles en tu plan: los planes actuales basados en créditos, incluido Free, las admiten; los planes antiguos pueden tener condiciones distintas. Las ejecuciones consumen créditos/recursos, no se promete funcionamiento ilimitado gratuito.

Si reutilizas la misma base del sitio anterior, desactiva su programador antes de activar el nuevo. Evita ambos despliegues procesando la misma cola.

## Verificación tras desplegar

Confirma en Functions: tick, publish-background, agent-background y creative-background. Revisa sus registros tras un minuto. Conecta una marca, genera una pieza de prueba, revisa el resultado y programa una publicación autorizada. Verifica luego los estados de Instagram y Facebook.

Pruebas locales: `node --experimental-strip-types lib/autopilot.test.mjs`, `node --experimental-strip-types lib/brand-agent-scheduler.test.mjs`, `node --experimental-strip-types lib/meta-media.test.mjs`, `node --experimental-strip-types lib/creative-references.test.mjs`. Son pruebas con SQLite y proveedores simulados; no publican ni consumen IA. Antes de operar, comprueba el build de Netlify y realiza una prueba real con tus cuentas.
