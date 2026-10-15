# Chat de productos

El apartado **Chat de productos** vive en la misma aplicación y sesión. Utiliza únicamente el proyecto Supabase de MegaControl. Instala `chat-productos.sql` después de las migraciones existentes y `eficiencia.sql`; la migración es repetible y no modifica PDF, Excel, salidas ni inventario.

Todos los miembros autorizados pueden conversar, responder, mencionar, compartir fotos y consultar el catálogo. El escaneo muestra una vista previa: **Compartir en el chat** o **Solicitar solución** confirma la publicación. Un escaneo por sí solo no registra productos ni cambia existencias. EAN, UPC y Code 128 utilizan el mismo lector de la aplicación; la cámara y sus bibliotecas se cargan al solicitarlas. También admite código manual, lector USB, referencia y búsqueda local por nombre.

**Sin coincidencia** significa ausencia en los documentos consultables, no en el inventario de caja. Un índice incompleto se muestra como tal. El precio de una tarjeta corresponde al momento de su consulta; **Comprobar precio actual** consulta nuevamente el catálogo y los precios administrativos. Las referencias no se convierten en códigos de barras.

Las incidencias tienen estados Pendiente, En proceso, Resuelto y No identificable. Dos usuarios que solicitan el mismo código pendiente se vinculan a un caso. Los administradores pueden asignar, explicar cambios, registrar un producto confirmado o asociar una etiqueta real a un producto existente. La tarjeta original cambia para todos; cada decisión conserva autor, fecha de Panamá y motivo. Los cambios concurrentes exigen recuperar el estado actual. El historial permanece consultable por estado y por páginas.

**Editar precio** reutiliza el historial de precios administrativo y su control de concurrencia. Una asociación utiliza el precio actualizado del producto vinculado. Un registro manual se distingue de una factura; no sustituye PDF o Excel ni conecta con el inventario externo de caja.

Los mensajes, productos, motivos y fotos se cifran en el navegador con la clave del equipo. Las RPC fijan autor y hora y comprueban membresía/rol. Las tablas tienen RLS con guardas restrictivas; no hay permisos de escritura directa para usuarios ni claves administrativas en el navegador. Las notificaciones son privadas por destinatario y se deduplican por mensaje, evento y versión.

## Consumo del plan Free

- Un único canal Realtime para documentos, consultas, precios y chat.
- Historial por páginas de 40 mensajes; actualizaciones incrementales y consultas agrupadas.
- Comprobación de respaldo cada 120 segundos con Realtime activo y 30 si se desconecta. Se pausa con la pestaña oculta.
- Stickers locales y emojis sin archivos adicionales en Supabase.
- Fotos comprimidas hasta 160 KB, cifradas en el bucket privado `mega-chat-images`. Se descargan solo al pulsar **Ver foto del producto**.
- Reserva máxima de 80 MB para fotos del chat (hasta 511 archivos, reservando 160 KB más el cifrado por foto); al alcanzarlo se mantiene disponible el envío de texto. No se borran conversaciones automáticamente.
- Los respaldos locales existentes incluyen las tablas del chat, decisiones y fotos, conservando la reutilización incremental y la compatibilidad con respaldos anteriores.

## Validación

`tests/chat-sql.test.cjs` ejecuta la migración real en PostgreSQL/PGlite: permisos, acceso revocado, idempotencia, incidencias únicas, concurrencia por revisión, notificaciones privadas, archivos y respaldos. Las pruebas `product chat` de `tests/traza.browser.cjs` conectan dos cuentas con cifrado real y un backend de prueba compartido; cubren PC, vista móvil, respuestas, fotos, cámara denegada, reintentos, paginación, persistencia y resolución. Son pruebas de navegador; no sustituyen una prueba con la cámara física de cada teléfono.
