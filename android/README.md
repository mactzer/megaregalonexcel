# MegaControl para Android

Aplicación Android **nativa**, con Views de Android, Camera2, ZXing, PdfRenderer y un cliente HTTPS propio. No contiene WebView, HTML, JavaScript ni una copia de la página. Requiere Android 8 o posterior y una conexión a Internet para verificar acceso y comprobar precios.

## Funciones implementadas

- Acceso con las cuentas existentes de MegaControl y comprobación del rol en Supabase.
- El mismo cifrado PBKDF2/HKDF/AES-GCM y HMAC de la web. Las claves y los tokens de sesión permanecen en memoria; la caché del catálogo y las consultas pendientes se guardan cifradas.
- Consulta por código, referencia o nombre. Usa el índice compartido existente y una caché cifrada en el teléfono. No vuelve a descargar los PDF al escanear.
- Escáner Camera2 con enfoque continuo, zoom y linterna, y lectura de etiquetas desde una foto. EAN, UPC, Code 128, Code 39 e ITF. Los códigos se conservan como texto.
- Precio por fecha de factura y número de salida; precio administrativo separado. Muestra las salidas y avisa cuando el índice está incompleto o hay precios contradictorios.
- Edición administrativa de precios, motivo, historial y restauración; las RPC existentes conservan los controles de permisos, concurrencia e idempotencia.
- Archivo con paginación, búsqueda exacta, detalles, versiones, visor PDF nativo y guardado de PDF/Excel originales mediante el selector de Android.
- Consultas compartidas y reintentos con el mismo UUID y contenido cifrado.
- Lectura del chat, tarjetas de producto, fotos bajo demanda y envío de texto y productos.
- Una conexión Realtime autenticada, con comprobaciones de respaldo y pausa al salir de la aplicación.
- Actualizador de APK firmado. Comprueba nuevas versiones una vez al día al entrar, con opción manual en el menú. Verifica SHA-256, nombre del paquete, versión y certificado antes de solicitar al sistema la instalación.

Esta primera implementación nativa no convierte ni registra PDF nuevos, no genera versiones nuevas del Excel y no incluye la administración completa de incidencias, usuarios, respaldos o fotos nuevas del chat. Esas funciones continúan disponibles en la web; la app no las presenta como implementadas ni las abre en un navegador oculto. No se ha cambiado el funcionamiento de la página existente.

La app usa exclusivamente el proyecto MegaControl indicado en `supabase-config.js`. No emplea credenciales de Cotizar, claves `service_role` ni tokens de administración. No se crean tablas, copias adicionales de documentos ni otro proyecto de Supabase.

## Compilar

Se utilizan las herramientas oficiales del SDK, sin Gradle ni un servicio de compilación externo:

- JDK 21 (incluido el módulo `jdk.compiler`).
- Android SDK `platforms;android-35` y `build-tools;35.0.0`.
- Python 3.
- Un almacén de firma propio, fuera del repositorio. Nunca se incluye en el APK, en Git o en Pages.

```sh
python3 android/build-apk.py \
  --sdk "$ANDROID_HOME" \
  --keystore /ruta/privada/megacontrol-release.jks
```

La contraseña se toma de `MEGACONTROL_ANDROID_STORE_PASSWORD`. No se imprime ni se pasa como texto en los argumentos. El alias predeterminado es `megacontrol`. El script no genera claves de firma silenciosamente. **Conservar esta clave es necesario para actualizar una instalación sin desinstalarla.**

El resultado y su SHA-256 se generan en `android/build/`, ignorado por Git. Se verifican las firmas APK v2/v3 y la alineación. `dependencies.json` fija las bibliotecas, versiones y hashes; solo se descargan artefactos que coincidan.

## Verificación

Los contratos usan cuentas, claves y productos ficticios. No inician sesión ni escriben pruebas en la base real:

```sh
ANDROID_JSON_TEST_JAR=/ruta/org-json-tests.jar node android/tests/run-contract.cjs
python3 android/build-apk.py --sdk "$ANDROID_HOME" --keystore /ruta/firma-pruebas.p12 --with-tests
adb install android/build/MegaControl-1.1.0.apk
adb install android/build/MegaControl-1.1.0.test.apk
adb shell am instrument -w io.github.mactzer.megacontrol.tests/io.github.mactzer.megacontrol.NativeSmoke
```

Los contratos comprueban la interoperabilidad web ↔ Java, datos alterados, fechas de factura frente a ingreso, códigos con ceros, reutilización del índice, precios administrativos, concurrencia/reintentos y consultas compartidas. La instrumentación ejecuta las vistas, cifrado y almacenamiento en Android, incluyendo una imagen Code 128 ficticia y un PDF creado para la prueba. La cámara física requiere una comprobación adicional en los teléfonos del equipo.

## Actualizaciones

Los datos se sincronizan con la misma base. El código nativo se entrega en APK nuevos: modificar un HTML de la web no convierte automáticamente ese cambio en una pantalla Android. Mantener ambas interfaces exige actualizar su implementación correspondiente.

Cada actualización aumenta `VERSION_CODE` y `VERSION` en `build-apk.py`, se prueba y se firma con la misma clave. Se publica en una release `android-vX.Y.Z` del repositorio, con un archivo `MegaControl-X.Y.Z.apk`. El menú de la app permite comprobarla y descargarla; Android pide confirmar la instalación. No se promete una instalación silenciosa.

Para publicar, se conserva únicamente el APK firmado y su `.sha256` en `android/distribution/`. El workflow verifica la firma pública, versión y contenido de esa distribución, además de ejecutar las pruebas nativas. Solo tras pasar las pruebas en `main`, publica esos mismos bytes en Releases con el token temporal de GitHub Actions. El APK de pruebas y las claves privadas nunca se publican. No requiere guardar la clave privada de firma ni una credencial de Supabase en GitHub Actions.

## Diseño y cámara (1.1.0)

Navegación inferior con iconos vectoriales, controles con superficies y estados propios, tarjetas redondeadas, precio destacado y chat con compositor fijo. La vista previa conserva las proporciones y compensa solo la rotación de la pantalla: TextureView ya orienta el sensor. No se añade un segundo giro de 90°. Se verifica con invariantes de geometría y una cámara en vivo del emulador, además de las pruebas de cifrado y documentos. El workflow conserva capturas de acceso, escáner, precio, archivo, consultas, chat y cámara para revisión visual.
