MegaControl | CONTROL DE SALIDAS DE MEGA REGALÓN

NAVEGACION Y PERFIL
Nueva salida: Cargar PDF -> Revisar informacion -> Guardar Excel.
Archivo de salidas: historial automatico al iniciar sesion, sin perder el PDF
cargado al cambiar de seccion en la misma pagina.
El perfil superior permite iniciar/cerrar sesion. Para administradores,
Usuarios y permisos y Seguridad se abren en dialogos. Guarda la clave de
recuperacion en un archivo privado y protegido; no se muestra en el historial.

ARCHIVO Y DESCARGAS
Filtra por numero exacto (incluye ceros iniciales), responsable y fechas de
Panama. Accesos rapidos: Todo, Hoy, Esta semana (desde lunes) y Este mes.
Actualizar conserva los filtros; Limpiar los elimina. Unidades en esta pagina
suma solo los registros visibles. Los registros dañados siguen visibles, con
aviso y documentos desactivados: se suman Unidades verificadas en esta pagina.
El detalle muestra el responsable oficial, fecha, productos, unidades,
nombres de documentos y vista previa local de la primera pagina del PDF.
La vista conserva las proporciones y ajusta su resolucion al tamaño de pantalla.
Ampliar, Reducir y Ajustar a ancho permiten leer los detalles. Ver PDF ampliado
abre un visor grande, con cierre mediante boton o Escape, sin recuperar otra
vez el documento. Las imagenes escaneadas conservan la calidad del PDF original.
Chrome y Edge compatibles permiten elegir carpeta y nombre antes de guardar.
Otros navegadores usan su configuracion de descargas. Cancelar el selector
detiene la operacion. El convertidor confirma la auditoria antes de escribir
el Excel; reintentar una escritura local fallida no duplica el registro.

EDITAR UN EXCEL GUARDADO
En el Archivo, Editar Excel recupera el PDF original con la misma sesion y abre
el convertidor. Elige otras columnas (codigo de barras, descripcion, etc.),
cambia sus encabezados o el nombre del Excel y guarda una nueva copia.
El numero de salida se conserva. Antes de guardar se confirma el acceso al
registro existente: no se suben documentos ni se crea otra salida. El PDF y
el Excel originales siguen en el Archivo. audit.html abre esa misma aplicacion.

CONFIRMACION DE GUARDADO
La app muestra una confirmacion visible con el nombre del archivo guardado.
Elegir carpeta escribe el archivo alli; Chrome y Edge no lo muestran en su
panel de descargas. Descargar una copia inicia otra descarga con los mismos
bytes, sin registrar de nuevo la salida. Esa copia usa la configuracion de
descargas del navegador. Cambiar de seccion o cerrar sesion limpia la
confirmacion y la copia disponible.

AUDITORIA CON SUPABASE
La version publicada usa usuario y contraseña y guarda una auditoria compartida.
Los PDF, Excel y datos comerciales se cifran en el navegador antes de subirlos.
Abre supabase-setup.html desde GitHub Pages para instalar tablas y permisos.
Consulta supabase/LEEME.md. No requiere Python ni una PC interna encendida.
Los archivos cifrados quedan fuera de la empresa; Supabase ve cuentas y fechas.
Guarda la copia de recuperacion en un lugar protegido y usa contraseñas fuertes.

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
La lectura se realiza localmente en el navegador. En GitHub Pages, al descargar,
el PDF y Excel se cifran y se guardan en Supabase con la auditoria compartida.
En la versión interna con auditoría, el PDF y el Excel se guardan también en
la computadora que comparte el historial dentro de la empresa.
Las librerías necesarias están incluidas dentro de la carpeta "vendor".

Limitación actual
-----------------
La primera versión funciona con PDFs que contienen texto y tablas. Si el PDF es una
imagen escaneada, será necesario agregar un módulo OCR en una versión posterior.
