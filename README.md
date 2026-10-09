# MegaControl | Control de salidas de Mega Regalón

MegaControl permite revisar salidas, seleccionar columnas de un PDF con texto y guardar un Excel. La conversión se realiza en el navegador. La versión publicada utiliza Supabase para compartir la auditoría: cifra el PDF, el Excel y los datos comerciales antes de subirlos. También conserva una modalidad interna con SQLite. No incluye OCR para documentos escaneados.

El logo personalizado combina la M de Mega Regalón con documentos, una hoja de cálculo y una flecha de salida. Se incluye en `megacontrol-logo.png`, con fondo transparente, y se utiliza también como icono de la pestaña del navegador.

## Navegación y documentos

**Nueva salida** presenta tres pasos: cargar PDF, revisar información y guardar Excel. **Archivo de salidas** consulta el historial compartido sin abandonar la aplicación: cambiar de sección conserva el PDF cargado y la sesión. El encabezado muestra el perfil; desde él puedes iniciar o cerrar sesión. Los administradores abren **Usuarios y permisos** y **Seguridad** en diálogos. La clave de recuperación se guarda como un archivo privado; consérvala en una ubicación protegida.

El archivo admite número exacto (conservando ceros iniciales), responsable y fechas Desde/Hasta, además de Todo, Hoy, Esta semana y Este mes. Las fechas y horas corresponden a Panamá; la semana empieza el lunes. Al aplicar filtros se vuelve a la primera página; Actualizar conserva los filtros y Limpiar los elimina. El número se busca mediante un índice cifrado, sin enviar el número comercial en texto claro.

Al entrar en el Archivo, las unidades y los productos de cada salida se recalculan automáticamente desde su PDF original autorizado, con el mismo parser del convertidor. Esto corrige los totales históricos que se guardaron antes de reconocer separadores de miles. La fila, el detalle y la suma de la página utilizan el mismo resultado. Durante la comprobación aparece **Verificando unidades…**; **Actualizar** vuelve a leer los PDF sin eliminar los filtros. El número comercial sigue siendo el registrado, aunque se haya editado al convertir.

La suma **Unidades en esta página** corresponde solo a los registros visibles, no a todo el archivo. Solo se incluyen las salidas cuyos productos y cantidades se comprobaron completamente. Si un PDF falla o hay unidades ilegibles, la fila muestra **Unidades no verificadas**, conserva sus documentos y se excluye de **Unidades verificadas en esta página**. Si los metadatos no pueden descifrarse, la fila permanece con los datos verificables y sus documentos desactivados. Los responsables y las fechas proceden del servidor.

La comprobación no crea salidas ni reescribe documentos o metadatos históricos. Los resúmenes numéricos se conservan únicamente en memoria durante la sesión, y las tareas y copias claras del PDF se cancelan y limpian al invalidar la vista. Cuando el total histórico cambia, el detalle indica **Editar Excel** para generar el Excel corregido; **Guardar Excel** mantiene la descarga del original archivado.

Al abrir una salida, el detalle muestra sus documentos y una vista previa real de la primera página del PDF, renderizada localmente. Puedes guardar el PDF y el Excel por separado. El Excel se descarga una sola vez mediante el navegador, sin pedir **Descargar una copia**. Para el PDF, Chrome y Edge compatibles permiten elegir carpeta y nombre antes de recuperar el documento; cancelar ese selector detiene la operación. En otros navegadores se utiliza la configuración habitual de descargas.

La vista previa se renderiza con la resolución de la pantalla, mantiene las proporciones del PDF y se vuelve a dibujar al cambiar el tamaño de la ventana. **Ampliar**, **Reducir** y **Ajustar a ancho** permiten leer los detalles; **Ver PDF ampliado** abre un visor grande que se cierra con su botón o Escape. El zoom vuelve a renderizar el PDF localmente, sin descargarlo de nuevo. La resolución original del documento limita la nitidez de las imágenes escaneadas.

Al descargar desde el convertidor, el nombre sugerido es **Salida [número].xlsx** y se puede editar. La auditoría se confirma antes de iniciar la descarga. Repetir exactamente el mismo Excel durante la misma sesión verifica el acceso a la salida registrada y reutiliza sus bytes, sin crear otro registro. Si cancelas el diálogo de guardado del navegador después de esa confirmación, la salida registrada se conserva y puedes repetir la descarga. Cambiar de PDF o cerrar sesión limpia la copia retenida en memoria. Las cantidades con separadores de miles, como `1,800.00`, se interpretan como 1800; los códigos de barras siguen siendo texto.

**Editar Excel** recupera el PDF autorizado de una salida del Archivo y abre el convertidor con la misma sesión. Puedes elegir nuevamente las columnas (incluido el código de barras), cambiar sus encabezados y el nombre del Excel. El número de la salida se mantiene; al guardar se confirma de nuevo el acceso al registro existente. Esta copia no sube documentos ni crea otra salida: el PDF y el Excel originales permanecen en el Archivo. `audit.html` abre directamente el Archivo de la misma aplicación.

La descarga del Excel muestra una confirmación visible con su nombre y aparece en el panel de descargas del navegador. Para elegir la carpeta en cada descarga, activa **Preguntar dónde guardar cada archivo** en los ajustes de descargas de Chrome o Edge. Para abrirlo automáticamente en Excel, descarga un `.xlsx` y selecciona **Abrir siempre archivos de este tipo** en el menú de ese archivo en el panel de descargas, si el navegador ofrece esa opción. Excel debe estar instalado y asociado a `.xlsx`; la página no puede modificar esos ajustes ni abrir una aplicación local por sí sola. El PDF guardado con el selector de la app conserva su copia opcional mediante **Descargar una copia**. Las confirmaciones y URLs temporales se limpian al cambiar de sección o cerrar sesión.

## Desarrollo y validación

### Escáner para celulares

Abre `movil.html` desde el sitio servido por HTTPS. Entra con la misma cuenta aprobada y contraseña de MegaControl. **Escanear producto** utiliza la cámara trasera y ZXing local, compatible con EAN-13, EAN-8, UPC-A y Code 128, incluyendo navegadores sin BarcodeDetector. También puedes escribir el código. La cámara se detiene tras reconocer un código, al ocultar la página y al cerrar sesión. La linterna aparece únicamente cuando el dispositivo permite controlarla.

La consulta recorre el historial autorizado del más reciente al más antiguo, con páginas de 25 registros. Descifra y analiza los PDF originales con el mismo parser del convertidor; no usa un catálogo ficticio ni crea otra base. Conserva los códigos como texto y reconoce la equivalencia estándar de UPC-A con su EAN-13 precedido de cero. Los PDF actuales contienen códigos numéricos de 5 a 14 dígitos; reconocer un Code 128 alfanumérico con la cámara no amplía lo que el parser del documento puede extraer.

La ficha identifica la salida y su fecha oficial. **El precio es P/Venta del PDF, no un precio vigente confirmado de inventario.** Los documentos no contienen necesariamente categorías, imágenes ni estado de inventario. La búsqueda se realiza de nuevo para cada consulta; un historial grande puede tardar. No encontrar coincidencias en los PDF no confirma que el producto falte en otro sistema de inventario. Si un documento no se puede leer, se muestra una consulta incompleta; si se encuentra un producto después de un documento ilegible más reciente, se avisa que podría existir una versión posterior.

El motor interno carga `index.html` en un iframe del mismo origen para reutilizar la sesión, el cifrado y el parser existentes. No se exportan tokens ni claves al código móvil. Los resultados y las últimas 20 consultas solo viven en memoria y se borran al salir; no se escriben datos comerciales ni contraseñas en almacenamiento del navegador. Se requiere Internet para Auth y documentos. Puedes agregar la página a la pantalla de inicio desde Safari (**Compartir → Agregar a inicio**) o mediante la opción de instalación disponible en tu navegador Android. El manifiesto no implica funcionamiento sin conexión.

Para probarla en desarrollo, sirve el repositorio con `python3 -m http.server 8000`. La cámara en un teléfono requiere un sitio HTTPS: una dirección HTTP de la red local no permite usarla. La publicación de GitHub Pages incluye los archivos móviles. Una vez publicado el cambio, la ruta será `https://mactzer.github.io/megaregalonexcel/movil.html`; no está desplegada por el solo hecho de editar el checkout. No ejecutes SQL de instalación sobre el historial existente para usar esta consulta.

Las pruebas móviles integradas cubren descifrado real con documentos ficticios, conservación de códigos, precio y procedencia, ausencia frente a consulta incompleta, cámara denegada, revocación de acceso y lectura efectiva de EAN-13 con ZXing mediante un stream de cámara generado para la prueba. Ejecuta `NODE_PATH=/workspace/mega-audit-tools/node_modules node --test --test-name-pattern='mobile scanner:' tests/traza.browser.cjs` o la suite de navegador completa.

Esta página implementa escaneo y consulta del archivo. No implementa todavía las incidencias compartidas, chat, push/SMS ni edición de un catálogo independiente descritos en la propuesta de aplicación completa; requieren desarrollo y tablas con permisos adicionales. No muestra confirmaciones de alertas enviadas ni notificaciones simuladas.

La interfaz utiliza `traza.css` y `traza.js`, con iconos locales y bibliotecas incluidas en `vendor`. No requiere compilación. Sirve la carpeta con `python3 -m http.server 8000`. Las dos modalidades de auditoría conservan su almacenamiento independiente: Supabase con cifrado en el navegador e intranet con el servidor Python y SQLite. Abrir un HTML directamente no sustituye la instalación del servicio de auditoría.

Las pruebas de conversión, cifrado y SQL se ejecutan así (la dependencia de PGlite se instala fuera del repositorio):

```sh
npm install --prefix /tmp/mega-audit-tests --ignore-scripts --no-audit --no-fund @electric-sql/pglite@0.5.8
NODE_PATH=/tmp/mega-audit-tests/node_modules node --test tests/*.test.cjs
python3 -m unittest discover -s tests -p 'test_*.py'
```

La prueba `tests/traza.browser.cjs` utiliza Playwright y Chromium, documentos ficticios, cifrado real y Supabase simulado. Sus resultados no acreditan el acceso de una cuenta real a producción. Consulta el encabezado de esa prueba para ejecutarla con Playwright instalado fuera del checkout.

## Autoría y condiciones de uso

Creado por **Eddie Rivera**. © 2026 Eddie Rivera. Todos los derechos reservados sobre el código propio de esta aplicación.

**Condición de uso establecida por el creador:** en caso de que Eddie Rivera sea despedido de la empresa que utiliza esta aplicación, la autorización de dicha empresa para usar la página queda revocada. Para continuar utilizándola, la empresa deberá dialogar con Eddie Rivera y acordar una compensación económica. El uso posterior requiere su autorización previa y por escrito, con las condiciones económicas pactadas por ambas partes.

Las bibliotecas de terceros incluidas en `vendor` conservan sus propias licencias y atribuciones.

## Publicación automática

El workflow `.github/workflows/pages.yml` publica la aplicación al subir cambios a `main`. Puedes seguir el despliegue en la pestaña **Actions**. Si GitHub pide habilitar Pages, selecciona **GitHub Actions** en **Settings → Pages**.

Enlace previsto: https://mactzer.github.io/megaregalonexcel/

## Publicar manualmente en GitHub Pages

1. Crea un repositorio público en GitHub, por ejemplo `megaregalonexcel`.
2. Descomprime el ZIP y sube **el contenido** de la carpeta `megaregalonexcel` a la raíz del repositorio. `index.html` y la carpeta `vendor` deben quedar juntos. Conserva todos los archivos de `vendor`.
3. En el repositorio, entra en **Settings → Pages**.
4. En **Build and deployment**, elige **Deploy from a branch**.
5. Selecciona la rama **main**, la carpeta **/ (root)** y pulsa **Save**.
6. Espera a que GitHub termine la publicación. En esa misma pantalla aparecerá el enlace, normalmente `https://mactzer.github.io/megaregalonexcel/`.

Abre el enlace publicado, selecciona un PDF con texto, marca las columnas y pulsa **Descargar Excel**. Usa la dirección de GitHub Pages; la vista del archivo en github.com muestra el código.

Para la versión de GitHub Pages no hace falta instalar Python ni dejar una computadora interna encendida. Las librerías PDF.js y SheetJS están incluidas. La auditoría requiere instalar las tablas y permisos en el proyecto Supabase configurado.

## Auditoría cifrada con Supabase

Abre [la instalación guiada](https://mactzer.github.io/megaregalonexcel/supabase-setup.html) para copiar el SQL, configurar el acceso y activar tu propia cuenta administradora. La [guía completa](supabase/LEEME.md) incluye los pasos y la copia de recuperación.

Cada persona utiliza **usuario y contraseña**, sin escribir un correo. El navegador deriva una credencial para Supabase Auth y una clave distinta que desbloquea el cifrado del historial. El PDF, el Excel, el nombre del archivo, las cantidades y el número de salida se cifran antes de subir. La búsqueda funciona por **número exacto** y conserva sus ceros iniciales. Los documentos se guardan en un bucket privado; las tablas y archivos solo están disponibles para miembros aprobados.

Supabase fija la identidad del autor y la fecha y hora del registro. La interfaz muestra la hora de Panamá. Se registra antes de descargar y los reintentos no duplican una salida confirmada. Las claves desbloqueadas y sesiones permanecen en memoria; al recargar, se inicia sesión nuevamente. El administrador puede abrir el historial desde el conversor sin recargar la página.

**Los datos cifrados se almacenan fuera de la empresa.** Supabase puede ver cuentas, identificadores, fechas y tamaños. Las contraseñas deben ser fuertes, de al menos 12 caracteres. Conserva una copia protegida de recuperación; no cambies contraseñas directamente en Supabase Auth porque el acceso está vinculado a claves cifradas por usuario. El historial local anterior no se migra automáticamente.

El código público utiliza únicamente la URL y clave `anon` suministradas. No contiene `service_role`, secretos ni contraseñas. El SQL Editor del dueño del proyecto es necesario para instalar las tablas y aprobar el primer administrador; la clave pública no concede ese permiso.

## Auditoría compartida en la red de la empresa

La versión interna permite buscar las salidas y consultar quién generó cada Excel y a qué fecha y hora. Conserva el PDF original y el Excel generado, con descargas protegidas por cuentas individuales. Todos los compañeros conectados a la misma instalación comparten el historial. Los registros se guardan antes de iniciar la descarga: un error al guardar impide una descarga sin registro.

Esta modalidad opcional utiliza una computadora autorizada dentro de la empresa para alojar la aplicación completa y su base de datos SQLite. No utiliza servicios de nube ni requiere acceso al servidor central. Necesita Python 3.10 o posterior, permanecer encendida y permitir acceso desde las computadoras de los compañeros. Se utiliza desde la dirección interna y conserva su historial independiente del de Supabase.

En Windows, extrae el proyecto completo y abre **`iniciar_auditoria.bat`**. El primer inicio crea la cuenta administradora. Abre `http://127.0.0.1:8080/` y crea las cuentas de tus compañeros desde la auditoría. Comparte la dirección IPv4 de esa computadora con el puerto `8080`.

Consulta [la guía de instalación, respaldos y HTTPS](intranet/LEEME.md). HTTP no cifra las contraseñas ni los documentos en la red; la guía explica cómo utilizar un certificado de la empresa. Los datos se guardan fuera del repositorio y no se suben a GitHub.

## Nombre del archivo Excel

Después de cargar un PDF, revisa el campo **Salida**. La aplicación toma el número del documento como valor inicial y permite corregirlo. Ingresa solo el número: por ejemplo, `1234` descarga el archivo **Salida 1234.xlsx**. El nombre completo se muestra automáticamente; no hace falta escribir la palabra Salida ni la extensión. Debes ingresar un número para descargar.

## Productos gravados y exentos

El impuesto se calcula con la tasa **I.V. de cada producto** aplicada a su importe en **Salidas - Total**. Por ejemplo, `G 7.00` aplica el 7 %; `E`, `EXENTO`, `0.00` y, en estos reportes, **I.V. vacío** corresponden a productos exentos (0 %). Se suman los impuestos sin redondear cada línea y se redondea el resultado final a dos decimales.

La página y el Excel muestran la base gravada, la base exenta y el impuesto calculado. Los productos exentos se incluyen en el subtotal y en el total de unidades, con impuesto cero. El impuesto impreso en el PDF se conserva como referencia para comparar. Las tasas no reconocidas o los importes ausentes se señalan para revisión y no producen un impuesto automático completo.

Para corregir el importe del impuesto, activa **Usar un impuesto manual**. Al desactivarlo, se recupera el cálculo por producto.

## Tabla de Excel

La hoja **Datos** se descarga como una tabla de Excel con encabezados, filtros y filas alternadas en gris. La tabla incluye los productos y el resumen inferior, conservando el orden de las columnas seleccionadas, las fórmulas y los códigos como texto.

## Uso local

Para la modalidad interna con SQLite utiliza `iniciar_auditoria.bat`. Para Supabase utiliza el enlace de GitHub Pages; también puedes servir el proyecto para desarrollo con `python -m http.server 8000` y abrir `http://localhost:8000`. Abrir los HTML directamente desde el explorador no sustituye la instalación de Supabase.

Consulta `README.txt` para los detalles de extracción y cálculo de totales. Revisa el resultado antes de utilizarlo: la extracción depende del formato del PDF.
