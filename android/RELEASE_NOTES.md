MegaControl Android 1.1.0 · Diseño y cámara

- Rediseño nativo: identidad verde de MegaControl, iconos vectoriales, navegación inferior, botones redondeados, campos claros y tarjetas con mejor jerarquía.
- Pantalla de consulta con acceso directo a la cámara y fotos, búsqueda por código/referencia/nombre y precio destacado.
- Cámara corregida: se elimina el segundo giro de 90° y el estiramiento de la imagen. Vista vertical con marco de lectura, enfoque continuo compatible, zoom 1×/2×/3× y linterna.
- Chat con burbujas y campo de escritura fijo abajo; archivo, detalle, historial y visor PDF con controles coherentes.
- Conserva la conexión cifrada a la misma base de MegaControl, cuentas, permisos y documentos existentes. No crea tablas ni copias de archivos en Supabase.

**Actualizar:** descarga `MegaControl-1.1.0.apk` y ábrelo sobre la versión anterior. Está firmado con la misma clave; no es necesario desinstalar. También puedes buscar la actualización desde el menú de la app. Android solicita confirmar la instalación. Requiere Android 8 o posterior.

**Verificación:** contratos de cifrado y datos ficticios, geometría de vista previa para diferentes sensores y pantallas, instrumentación en Android 15 con cámara en vivo, lectura de Code 128 girado conservando ceros iniciales, navegación, visor PDF y descarga byte a byte. Capturas de las pantallas conservadas en GitHub Actions. La prueba del emulador no sustituye comprobar el enfoque y la calidad de la cámara del teléfono real.

**Alcance:** sigue pendiente importar PDF nuevos, regenerar Excel y la administración completa de usuarios, respaldos e incidencias o el envío de nuevas fotos al chat en Android. Esas funciones están disponibles en la web. La aplicación es nativa y no contiene WebView.
