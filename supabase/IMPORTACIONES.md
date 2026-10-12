# Facturas y otros PDF

En **Nueva salida**, carga el PDF original descargado desde el QR de la factura. Si solo tienes un escaneo, también puedes cargarlo. La aplicación utiliza el texto del original o lee las imágenes localmente con OCR; no envía la factura a un servicio de reconocimiento.

Las salidas habituales conservan su conversión automática. Para Nevada, Feduro, Skechers y documentos que no tengan la tabla de salidas, se abre **Revisar lectura del documento**:

1. Comprueba el tipo, número y **fecha impresa de emisión**. La fecha de llegada a la tienda o de carga no determina el precio.
2. Compara **todos** los productos con el PDF. Corrige código, referencia, descripción, cantidad e importes; utiliza **Añadir producto** o **Quitar producto** si es necesario. **Ver fila en el PDF** facilita la revisión.
3. El **precio de la factura** se conserva separado del **precio de venta**. El administrador puede escribir el precio de venta, aceptar explícitamente una sugerencia o aplicar un precio a varios productos seleccionados. **Usar precio de factura como venta** también requiere una decisión explícita; nunca se aplica de forma automática.
4. Marca la confirmación y guarda el Excel. Un administrador aprueba la lectura y sus precios. Un compañero puede archivar una lectura pendiente; sus productos aún no participan en las consultas. El administrador la abre desde **Archivo → Revisar lectura / Excel** para corregirla y aprobarla.

Los PDF digitales del **Comprobante Auxiliar de Factura Electrónica (DGI)** se leen completos, incluidas las páginas que continúan sin repetir los encabezados. Se separan cantidad, valor unitario, descuento, monto, ITBMS y total de la fila. En Feduro, el código de barras está entre llaves en **Información de interés**; la referencia está al inicio de **Descripción**. Se conservan los ceros iniciales y se recomponen las referencias impresas con letras separadas. Los totales impresos se conservan aparte de la suma de filas; una diferencia de redondeo no modifica los valores originales.

El QR identifica la factura; no sustituye los códigos de los productos. Si Skechers solo incluye referencias, se puede buscar por referencia. No se inventa un código de barras. Algunos digitales de Skechers no incluyen ni código ni referencia individual: se pueden archivar con los datos del pedido separados, y un administrador vincula después la etiqueta real desde Archivo. Las filas sin identificar no participan en búsquedas; el escáner informa que la consulta está incompleta cuando aún hay productos pendientes de identificación. Una referencia asociada con varios códigos exige consultar el código exacto para mostrar el precio.

Un escaneo puede contener errores de OCR, filas omitidas y números atravesados por lápiz. Los precios escritos a mano, incluidos los que abarcan varias filas con una llave, deben revisarse. Si el reconocimiento falla o el formato es desconocido, puedes ingresar las filas junto a la vista del original. Esto permite incorporar el documento sin aceptar datos ilegibles como ciertos. La primera lectura de imágenes puede tardar; las consultas posteriores utilizan la lectura aprobada y no ejecutan OCR.

## Precios y originales

Un precio compartido editado por un administrador conserva su prioridad. Luego se utiliza la última **salida**, según fecha impresa y número. Las demás facturas o pedidos se utilizan cuando el producto no aparece en una salida. La ficha muestra las fuentes, su precio confirmado y la fecha impresa. Un precio pendiente permanece sin definir.

La corrección de una lectura modifica los datos cifrados de consulta. Conserva el PDF y el Excel archivados originales; el Excel corregido se descarga como otra presentación. Un administrador puede usar **Volver a leer PDF original** para reconstruir una lectura incompleta con el lector actual, revisar los datos nuevos y aprobar la corrección sin volver a subir archivos. Reexportar una lectura sin cambios no genera otra revisión ni otro archivo en Supabase.

## Instalación y consumo

Ejecuta [importaciones.sql](importaciones.sql) después de las migraciones existentes de auditoría, precios y consultas-operaciones, en el proyecto **exclusivo de MegaControl**. Ejecuta también la versión actual de [respaldos.sql](respaldos.sql) para incluir a los administradores que revisaron importaciones en la recuperación. La migración es aditiva y se puede repetir. Esta función utiliza la modalidad de Supabase; la modalidad opcional de intranet continúa con su conversión de salidas.

No agrega tablas de productos ni duplica documentos. Guarda las filas confirmadas dentro de los metadatos ya cifrados del registro (límite de 160 KB para la lectura), junto con tipo, autor, fecha y revisión de aprobación. Las fechas de aprobación están separadas de la fecha de factura. Los permisos se comprueban en PostgreSQL; una cuenta común no puede aprobar precios cambiando el navegador.

La vista del catálogo conserva los permisos del registro y permite comprobar cambios mediante una revisión pequeña en vez de descargar todos los metadatos. Realtime avisa de nuevas lecturas; la comprobación de respaldo del catálogo con Realtime activo se espacia a dos minutos. Cada consulta sigue comprobando el acceso actual. Los modelos de OCR se descargan desde GitHub Pages solo al leer imágenes; no ocupan espacio en tu Supabase. Los respaldos existentes incluyen estos datos y los archivos originales, y la herramienta de recuperación acepta también respaldos anteriores a esta función.
