# SEO y Google en Social Studio

## Implementado

- Pestaña SEO y Google dentro de la navegación existente; reutiliza marcas, esencia y webs.
- Auditorías del HTML de hasta 10 URL configuradas por marca: título, descripción, H1, canonical, alt, noindex, viewport, idioma y presencia de JSON-LD.
- Puntaje interno orientativo, evidencia por URL, errores por recurso e historial de las últimas 10 auditorías.
- Agente IA con configuración de mercado y búsquedas por marca. Prepara un plan a partir de evidencia; usa OPENAI_API_KEY y SEO_AGENT_MODEL (opcional; mismo modelo de texto que el agente actual por defecto).
- Revisión diaria o semanal en Netlify. Cada agente comienza desactivado. Bloqueo por marca y reclamación atómica de ejecuciones evitan duplicados concurrentes.
- Google OAuth, tokens cifrados, asociación explícita por marca con propiedades autorizadas de Search Console y ubicaciones de Google Business.
- Lectura de hasta 30 consultas de Search Console de un periodo de 28 días, con tres días de margen, y datos del perfil de Google Business.

## Activación

1. Conservar Cloudflare D1 y las variables existentes de Social Studio.
2. Netlify debe desplegar `seo-background` y `seo-schedule`. Este último despierta el proceso cada 30 minutos sin modificar el cron de publicaciones existente. `SITE_ORIGIN` debe apuntar al origen HTTPS real y `CRON_SECRET` debe estar configurado.
3. Para Google: configurar `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` y la clave existente `INSTAGRAM_TOKEN_ENCRYPTION_KEY` (base64 de 32 bytes, también usada para cifrar el token SEO).
4. Añadir como URI de redirección autorizada en el cliente OAuth de Google Cloud: `https://TU-DOMINIO/api/seo/google`. Mantener la URI existente de Drive.
5. Habilitar Search Console API, My Business Account Management API y My Business Business Information API. Google Business puede requerir acceso aprobado y cuota; una cuenta conectada no confirma esos permisos. Configurar usuarios de prueba o publicación/verificación del consentimiento según el estado del proyecto.
6. En SEO y Google, conectar Google, cargar propiedades, escoger la propiedad y ficha de la marca, y guardar el agente. Confirmar que corresponden al negocio correcto.
7. Ejecutar la primera auditoría. Activar la frecuencia diaria/semanal por marca cuando se quiera revisión recurrente. La frecuencia se cuenta desde el inicio de la última ejecución, no a una hora fija.

## Alcance y límites

Esta versión automatiza auditorías y propuestas. No modifica webs, fichas, horarios, categorías ni reseñas; no publica contenido. Los conectores de escritura por plataforma, la aplicación/reversión de cambios, respuestas a reseñas y la medición de resultados entre periodos requieren una siguiente implementación y accesos específicos. No confundir agente programado con optimización aplicada.

No incluye PageSpeed, rastreo completo de subpáginas, comprobación de enlaces rotos, renderizado JavaScript, cobertura de indexación ni validación completa de schema. No convierte ausencia de JSON-LD en prueba de ausencia de todos los formatos de datos estructurados. El puntaje no es una posición en Google.

La conexión Google es del espacio del propietario y se seleccionan sus recursos por marca. Desconectar elimina el token local y las asociaciones de todas las marcas; no revoca otros permisos que el usuario tenga concedidos a la misma aplicación. Los informes guardados mantienen los datos capturados antes de desconectar.

## Comprobaciones

`node --test lib/seo.test.mjs` comprueba hallazgos HTML, separación de propietarios, bloqueo de ejecuciones simultáneas y recuperación de errores. `npx tsc --noEmit` y `npm run build` comprueban tipos y compilación. La autorización y consultas de Google requieren credenciales y cuenta real.
