Primera versión Android nativa de MegaControl, para Android 8 o posterior. Usa pantallas Android, Camera2, ZXing y PdfRenderer. No contiene WebView, HTML ni JavaScript.

Incluye acceso con las cuentas existentes, escáner y lectura de fotos giradas, búsqueda por código/nombre/referencia, precios según la última factura, edición administrativa de precios, archivo y versiones, visor PDF, guardado de PDF/Excel originales, consultas compartidas y chat básico. Se conecta a la misma base de MegaControl con el cifrado y los permisos existentes, sin crear tablas ni duplicar los documentos en Supabase.

**Alcance:** esta primera versión todavía no convierte ni registra PDF nuevos, no regenera Excel ni incluye la administración completa de usuarios, respaldos e incidencias o el envío de fotos nuevas al chat. Esas funciones continúan disponibles en la web.

**Instalar:** descarga `MegaControl-1.0.0.apk` y ábrelo en Android. El sistema puede pedir que permitas instalar aplicaciones desde tu navegador. Entra con tu cuenta habitual de MegaControl.

**Actualizaciones:** los datos se sincronizan con Supabase. La app busca nuevas versiones nativas una vez al día y también desde el menú. Comprueba el hash y la firma del APK; Android requiere confirmar la instalación. Un cambio en el HTML de la web requiere su implementación correspondiente en Android.

**Verificación:** contratos de cifrado web ↔ Java con datos ficticios, instrumentación en Android 15 emulado, lectura de Code 128 girado conservando ceros iniciales, navegación sin cerrar sesión, visor PDF y descarga byte a byte. Firma APK v2/v3 y alineación de 16 KB. La cámara física queda pendiente de comprobar en el teléfono del equipo. Las pruebas no escriben en la base real.

Código fuente e instrucciones: `android/README.md`. La clave privada de firma se conserva fuera del repositorio y nunca se publica.
