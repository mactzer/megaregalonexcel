# PDF a Excel — Selector de columnas

Aplicación para seleccionar columnas de un PDF con texto y descargar un Excel. La conversión se realiza en el navegador. En GitHub Pages los documentos permanecen en tu computadora; en la versión interna con auditoría se guardan también en la computadora que comparte el historial dentro de la empresa. No incluye OCR para documentos escaneados.

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

Para el convertidor de GitHub Pages no hace falta instalar paquetes ni configurar un servidor. Las librerías PDF.js y SheetJS están incluidas y usan rutas relativas compatibles con GitHub Pages.

## Auditoría compartida en la red de la empresa

La versión interna permite buscar las salidas y consultar quién generó cada Excel y a qué fecha y hora. Conserva el PDF original y el Excel generado, con descargas protegidas por cuentas individuales. Todos los compañeros conectados a la misma instalación comparten el historial. Los registros se guardan antes de iniciar la descarga: un error al guardar impide una descarga sin registro.

Una computadora autorizada dentro de la empresa aloja la aplicación completa y su base de datos SQLite. No utiliza servicios de nube ni requiere acceso al servidor central. Necesita Python 3.10 o posterior, permanecer encendida y permitir acceso desde las computadoras de los compañeros. El enlace público de GitHub Pages conserva el convertidor; el historial compartido se utiliza desde la dirección interna.

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

En Windows puedes abrir `abrir_app.bat`. También puedes ejecutar `python -m http.server 8000` desde esta carpeta y abrir `http://localhost:8000`.

Consulta `README.txt` para los detalles de extracción y cálculo de totales. Revisa el resultado antes de utilizarlo: la extracción depende del formato del PDF.
