PDF A EXCEL - SELECTOR DE COLUMNAS

VERSION 6 - TOTALES EN LA HOJA DATOS
Extrae todo el ZIP antes de abrir index.html o abrir_app.bat.
Para auditoría compartida entre compañeros, abre iniciar_auditoria.bat
en la computadora interna que guardará los documentos; requiere Python 3.10+.
Consulta intranet/LEEME.md para cuentas, acceso local, respaldos y HTTPS.
El Subtotal, Impuesto y Total Neto aparecen debajo de los productos en Datos.
Si incluyes Salidas - Total, el Subtotal usa una fórmula SUM en Excel.
Si no incluyes esa columna, se exporta la suma calculada al convertir el archivo.
El impuesto se calcula con la tasa I.V. de cada producto sobre Salidas - Total.
G 7.00 aplica el 7 %. E, EXENTO, 0.00 e I.V. vacío corresponden a exentos (0 %)
en estos reportes. Los exentos se incluyen en el subtotal sin añadir impuesto.
Se suman los impuestos de las líneas y se redondea el resultado final.
Puedes activar "Usar un impuesto manual" para corregir el importe, no el porcentaje.
Si la tasa no se reconoce o falta un importe, se pide revisión; no se supone cero.
Las filas sin total detectado se señalan para revisión, no se inventan importes.
Que la suma sea correcta no garantiza por sí solo que la extracción sea completa.

Uso
---
1. Abre la carpeta y haz doble clic en "abrir_app.bat".
2. Arrastra un PDF o pulsa "Seleccionar PDF".
3. Marca las columnas que quieres llevar al Excel.
4. Si deseas, cambia los nombres de las columnas.
5. Pulsa "Descargar Excel".

Seguridad de los datos
----------------------
La hoja "Datos" contiene solo las columnas que marques. Para evitar pérdida de
información, el archivo también crea automáticamente:
- "Información": Número, Fecha, Referencia, Destino y nombre del PDF.
- "Resumen": Subtotal, Impuesto, Total Neto, suma de los totales de productos,
  diferencias informativas y el estado del cálculo.
- "Respaldo original": todas las líneas de texto detectadas, incluyendo encabezados,
  referencias, códigos, totales y la información que no hayas seleccionado para la
  hoja principal.

El cálculo principal no depende del Subtotal ni del Total Neto impresos en el PDF:
- Subtotal calculado = suma de la columna "Salidas - Total".
- Impuesto = suma del importe de cada producto por su tasa I.V., redondeada al final.
- Total Neto calculado = Subtotal calculado + Impuesto.

Los valores impresos de Subtotal, Impuesto y Total Neto se conservan como referencia
informativa. Si el documento original tiene una diferencia, el Excel no modifica las
líneas ni fuerza el resultado; muestra el cálculo real de las líneas y la diferencia
informativa contra lo impreso.

Después de cargar el PDF, la pantalla también muestra Subtotal, Impuesto y Total Neto.

Las columnas que indiquen 0 registros están vacías en el PDF, pero se pueden marcar
para incluirlas como columnas vacías en el Excel.

Además, puedes marcar "Código completo" y "Fila original" si quieres ver esos datos
directamente en la hoja "Datos".

Para el documento de ejemplo
----------------------------
Selecciona:
- Código
- Costo
- Salidas - Unidades
- Salidas - Total (queda marcada automáticamente para comprobar el Subtotal)

En este tipo de reporte, "Salidas - Unidades" es la cantidad de unidades enviadas.
La aplicación conserva el código de barras como texto para no perder dígitos. El
campo "Código completo" conserva también el prefijo que aparezca antes del código,
como "01".

Privacidad
----------
La lectura se realiza localmente en el navegador. En GitHub Pages, el PDF no se sube.
En la versión interna con auditoría, el PDF y el Excel se guardan también en
la computadora que comparte el historial dentro de la empresa.
Las librerías necesarias están incluidas dentro de la carpeta "vendor".

Limitación actual
-----------------
La primera versión funciona con PDFs que contienen texto y tablas. Si el PDF es una
imagen escaneada, será necesario agregar un módulo OCR en una versión posterior.
