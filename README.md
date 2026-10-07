# PDF a Excel — Selector de columnas

Aplicación para seleccionar columnas de un PDF con texto y descargar un Excel. Funciona directamente en el navegador; los PDF no se envían a un servidor. No incluye OCR para documentos escaneados.

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

No hace falta instalar paquetes ni configurar un servidor. Las librerías PDF.js y SheetJS están incluidas y usan rutas relativas compatibles con GitHub Pages.

## Nombre del archivo Excel

Después de cargar un PDF, edita **Nombre del archivo Excel** antes de descargar. La descarga usa ese nombre y añade `.xlsx` automáticamente. Si dejas el campo vacío, se utiliza el nombre sugerido a partir del PDF.

## Uso local

En Windows puedes abrir `abrir_app.bat`. También puedes ejecutar `python -m http.server 8000` desde esta carpeta y abrir `http://localhost:8000`.

Consulta `README.txt` para los detalles de extracción y cálculo de totales. Revisa el resultado antes de utilizarlo: la extracción depende del formato del PDF.
