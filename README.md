# MegaControl | Control de salidas de Mega Regalón

MegaControl permite revisar salidas, seleccionar columnas de un PDF con texto y guardar un Excel. La conversión se realiza en el navegador. La versión publicada utiliza Supabase para compartir la auditoría: cifra el PDF, el Excel y los datos comerciales antes de subirlos. También conserva una modalidad interna con SQLite. No incluye OCR para documentos escaneados.

El logo personalizado combina la M de Mega Regalón con documentos, una hoja de cálculo y una flecha de salida. Se incluye en `megacontrol-logo.png`, con fondo transparente, y se utiliza también como icono de la pestaña del navegador.

## Navegación y documentos

**Nueva salida** presenta tres pasos: cargar PDF, revisar información y guardar Excel. **Archivo de salidas** consulta el historial compartido sin abandonar la aplicación: cambiar de sección conserva el PDF cargado y la sesión. El encabezado muestra el perfil; desde él puedes iniciar o cerrar sesión. Los administradores abren **Usuarios y permisos** y **Seguridad** en diálogos. La clave de recuperación se guarda como un archivo privado; consérvala en una ubicación protegida.

El archivo admite número exacto (conservando ceros iniciales), responsable y fechas Desde/Hasta, además de Todo, Hoy, Esta semana y Este mes. Las fechas y horas corresponden a Panamá; la semana empieza el lunes. Al aplicar filtros se vuelve a la primera página; Actualizar conserva los filtros y Limpiar los elimina. El número se busca mediante un índice cifrado, sin enviar el número comercial en texto claro.

La suma **Unidades en esta página** corresponde solo a los registros visibles, no a todo el archivo. Si un registro no puede descifrarse, permanece visible con un aviso y sus documentos desactivados; la suma se identifica como **Unidades verificadas en esta página**. Los responsables y las fechas proceden del servidor.

Al abrir una salida, el detalle muestra sus documentos y una vista previa real de la primera página del PDF, renderizada localmente. Puedes guardar el PDF y el Excel por separado. En Chrome y Edge compatibles, el selector de archivos permite elegir carpeta y nombre antes de recuperar el documento. En otros navegadores se utiliza la configuración habitual de descargas. Cancelar el selector detiene la operación.

Al guardar desde el convertidor, el nombre sugerido es **Salida [número].xlsx** y se puede editar. La auditoría se confirma antes de escribir el archivo o iniciar la descarga. Cancelar el selector no registra la salida; si una escritura local falla después de registrarla, reintentar no crea otro registro.

**Editar Excel** recupera el PDF autorizado de una salida del Archivo y abre el convertidor con la misma sesión. Puedes elegir nuevamente las columnas (incluido el código de barras), cambiar sus encabezados y el nombre del Excel. El número de la salida se mantiene; al guardar se confirma de nuevo el acceso al registro existente. Esta copia no sube documentos ni crea otra salida: el PDF y el Excel originales permanecen en el Archivo. `audit.html` abre directamente el Archivo de la misma aplicación.

El guardado muestra una confirmación visible con el nombre del archivo. Cuando eliges una carpeta, el navegador escribe el archivo allí y no lo añade a su panel de descargas. El botón **Descargar una copia** inicia una descarga adicional con los mismos bytes, sin volver a registrar la salida ni abrir otro selector. Puedes usarlo si quieres que aparezca en el panel del navegador; esa copia sigue su configuración habitual de descargas. La confirmación y la copia disponible se limpian al cambiar de sección o cerrar sesión.

## Desarrollo y validación

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
