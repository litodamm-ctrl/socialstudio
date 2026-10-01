# Social Studio para Netlify

Código fuente Next.js con calendario de Instagram, publicación en Facebook autorizada por marca y agentes de contenido. Usa Cloudflare D1 y R2 para datos y archivos. No incluye credenciales.

## Instalación

1. Descomprime el ZIP. Sube el CONTENIDO de la carpeta a GitHub, dejando package.json y netlify.toml en la raíz. Guarda un commit en main.
2. En Netlify elige Add new project / Import an existing project y conecta ese repositorio. No uses Netlify Drop: esta app necesita compilación y funciones.
3. netlify.toml configura `pnpm build`, publicación `.next` y Node 22. Netlify instala automáticamente su integración Next.js.
4. Configura las variables de `.env.example` en Environment variables para producción, disponibles para Functions y Builds. No subas claves a GitHub.
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

La función `tick` corre cada minuto en producción y lanza `publish-background`. Esta revisa publicaciones pendientes y genera como máximo una nueva pieza por ejecución, alternando las marcas según su última ejecución y buscando espacios durante siete días.

Crear con agente inicia `creative-background`, guarda el resultado en D1 y la pantalla consulta el progreso. Esto evita peticiones síncronas largas. Las tareas internas exigen CRON_SECRET; nunca uses un nombre NEXT_PUBLIC_ para secretos.

Las funciones programadas solo corren en producción. Las funciones de segundo plano deben estar disponibles en tu plan: los planes actuales basados en créditos, incluido Free, las admiten; los planes antiguos pueden tener condiciones distintas. Las ejecuciones consumen créditos/recursos, no se promete funcionamiento ilimitado gratuito.

Si reutilizas la misma base del sitio anterior, desactiva su programador antes de activar el nuevo. Evita ambos despliegues procesando la misma cola.

## Verificación tras desplegar

Confirma en Functions: tick, publish-background y creative-background. Revisa sus registros tras un minuto. Conecta una marca, genera una pieza de prueba, revisa el resultado y programa una publicación autorizada. Verifica luego los estados de Instagram y Facebook.

Se comprueba el paquete mediante compilación local. El despliegue y la prueba real con credenciales de Netlify, Cloudflare, Meta, Google y OpenAI quedan pendientes.
