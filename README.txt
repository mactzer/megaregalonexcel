PDF A EXCEL - SELECTOR DE COLUMNAS

VERSION 6 - TOTALES EN LA HOJA DATOS
Extrae todo el ZIP antes de abrir index.html o abrir_app.bat.
El Subtotal, Impuesto y Total Neto aparecen debajo de los productos en Datos.
Si incluyes Salidas - Total, el Subtotal usa una fórmula SUM en Excel.
Si no incluyes esa columna, se exporta la suma calculada al convertir el archivo.
El impuesto puede ingresarse o corregirse en pantalla como importe, no porcentaje.
Si falta, se muestra FALTA IMPUESTO; no se supone que sea cero.
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
- Impuesto = impuesto leído del documento.
- Total Neto calculado = Subtotal calculado + Impuesto.

Los valores impresos de Subtotal y Total Neto se conservan únicamente como referencia
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
La lectura se realiza localmente en el navegador. El PDF no se sube a ningún servicio.
Las librerías necesarias están incluidas dentro de la carpeta "vendor".

Limitación actual
-----------------
La primera versión funciona con PDFs que contienen texto y tablas. Si el PDF es una
imagen escaneada, será necesario agregar un módulo OCR en una versión posterior.
