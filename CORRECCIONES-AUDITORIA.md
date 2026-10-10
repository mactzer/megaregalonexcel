# Correcciones de consultas y auditoría — 10/10/2026

La aplicación utiliza el proyecto Supabase existente. No se migran cuentas ni se elimina ningún PDF, Excel o registro histórico.

## Causas comprobadas en el código

| Problema | Causa | Corrección |
|---|---|---|
| Detalle debajo de toda la lista en celular | El cambio a una sola columna colocaba el panel después de las filas. | Diálogo responsive en primer plano hasta 1150 px; cierre, Escape, foco y desplazamiento restaurados. Panel lateral de escritorio conservado. |
| Consultas visibles solo para quien consulta | `movil.js` mantenía una lista JavaScript privada, sin tabla ni recuperación compartida. | Consultas cifradas en `mega_product_queries`, lectura del equipo y autor oficial. |
| Consultas desaparecidas tras F5 | La lista estaba en memoria y se vaciaba al salir. | Recuperación desde Supabase después de autenticar; reintentos cifrados, estados de carga/error y última vista conservada ante fallo de red. |
| Repetición de la misma salida | La idempotencia protegía un UUID de intento; otro archivo exportado, otra sesión u otro usuario generaban un UUID diferente para la misma fuente. | Huella privada del PDF, reserva persistente y unicidad en PostgreSQL antes de subir/confirmar. Realtime reemplaza listas por ID, no agrega filas repetidas. |

Esta causa permite explicar duplicados accidentales nuevos; las capturas no acreditan por sí solas que dos facturas históricas sean la misma operación. La aplicación vuelve a comparar sus documentos originales y pide una decisión administrativa justificada antes de vincularlos.

## Archivos y componentes

- `audit-cloud.js`: recuperación/guardado de consultas, reserva y confirmación de operaciones, detalle móvil, sincronización y revisión de duplicados.
- `audit-crypto.js`: identidad del documento con SHA-256 y HMAC del equipo, independiente del nombre del Excel.
- `audit-realtime.js`: una conexión autenticada por sesión, actualización del token, reconexión y cierre al salir.
- `mobile-history.js`, `movil.js`, `movil.html`: historial compartido, recuperación de pendientes cifrados, reintento y estados verificables.
- `index.html`, `traza.css`: registro explícito de otro movimiento y detalle responsive; enlaces internos actualizados.
- `supabase/consultas-operaciones.sql`, `supabase-consultas.html`: migración aditiva y guía para el propietario.
- `.github/workflows/pages.yml`, `tests/*`, `README.md`: publicación de los componentes, comprobaciones y documentación.

## Activación requerida en producción

1. Abre [la guía publicada](https://mactzer.github.io/megaregalonexcel/supabase-consultas.html).
2. Copia **todo** `supabase/consultas-operaciones.sql`, abre el SQL Editor del proyecto actual y pulsa **Run**.
3. Recarga las pestañas antiguas. En Últimas consultas pulsa **Actualizar** y, si hay pendientes, **Reintentar guardado**.
4. Un administrador puede revisar las salidas antiguas desde **Archivo → Revisar duplicados**.

El SQL crea `mega_product_queries` y `mega_audit_operations`, añade asociaciones/revisiones a los registros existentes y configura RLS y funciones autorizadas. Es transaccional y repetible. Revoca el registro anterior para que una pestaña antigua no evite la reserva. Las consultas y descargas del Archivo anterior siguen disponibles si todavía falta la migración; los registros nuevos necesitan activarla.

La comprobación de producción del 10/10/2026 devolvió **HTTP 404 / PGRST205** al consultar la nueva tabla: faltaba aplicar la actualización. Este entorno tiene la clave pública de la aplicación, que no permite ejecutar DDL, y no dispone de una credencial administrativa de Supabase. Por eso el SQL se comprobó en PostgreSQL local y se entrega para ejecutar en el proyecto actual, sin afirmar que ya está instalado.

## Persistencia y sincronización

Cada consulta tiene UUID propio y contenido cifrado. Supabase fija autor y fecha/hora; las cuentas aprobadas recuperan las últimas 20 consultas del equipo, sin filtrar por autor. Los demás registros siguen guardados. RLS impide leer desde otra organización o sin aprobación; los clientes no tienen escritura directa. Reintentar la misma consulta conserva UUID y contenido y devuelve el mismo registro.

Los pendientes de confirmación se guardan cifrados por cuenta en IndexedDB; no contienen claves ni tokens. Si Supabase ya confirmó pero se perdió la respuesta, F5 y el reintento no duplican el registro. Una consulta todavía pendiente no se anuncia como guardada ni disponible para otros dispositivos.

Realtime escucha las dos tablas del equipo con una conexión por sesión. Cada aviso provoca recuperación autorizada por REST; se agrupan avisos y se reemplaza la lista por identificadores. No se insertan filas desde el aviso. Si Realtime falla, la vista visible consulta cada 10 segundos en el escáner y cada 15 segundos en Archivo. Al salir se cancelan la conexión, peticiones y vistas privadas. El historial se guarda aparte de la búsqueda del producto y no obliga a abrir los PDF en cada consulta.

## Prevención y tratamiento de duplicados

La clave única `(workspace_id, operation_tag)` y la reserva de `mega_audit_operations` protegen el guardado entre usuarios, sesiones y dispositivos. La huella corresponde al PDF completo; el cliente compara nuevamente sus bytes descifrados antes de reutilizar el registro. `mega_audit_record_v2` comprueba la identidad y la reserva en PostgreSQL. Una reserva abandonada puede recuperarse tras dos minutos; el intento sustituido no puede confirmar otro registro.

Cambiar nombre o columnas del Excel reutiliza la operación. Un PDF diferente conserva otra operación aunque tenga iguales productos, cantidades o fecha. Si una segunda operación real usa exactamente el mismo PDF, **Registrar otro movimiento** crea explícitamente una identidad nueva; no se pulsa para repetir una descarga.

En el historial, los PDF idénticos son candidatos, no decisiones automáticas. Solo un administrador puede confirmar que se trata de la misma operación, indicar el principal y escribir el motivo, o conservarla como movimiento distinto. La decisión queda en Supabase con autor, hora y explicación cifrada. Se mantiene la relación persistente `duplicate_of`; los archivos y registros originales se conservan y se pueden descargar desde **Registros vinculados**. No se vinculan documentos diferentes por semejanza de productos o números.

## Comprobaciones obligatorias

Las siguientes comprobaciones usan Chromium, dos contextos independientes, documentos ficticios, cifrado real y transporte Supabase/Realtime simulado. Las funciones, restricciones y RLS SQL se prueban en PostgreSQL mediante PGlite.

| Escenario | Comprobación |
|---|---|
| Detalle en computadora | Panel lateral y vista previa local conservados. |
| Detalle en celular y tablet | Visible en primer plano; cierre y Escape devuelven foco y posición. |
| Consulta de A visible para B | Registro cifrado, autor oficial y aviso Realtime en el segundo contexto. |
| F5 | Inicio de sesión y recuperación del mismo historial sin nueva inserción. |
| Cerrar/abrir navegador | Nuevo contexto recupera el historial de la base compartida. |
| Registro y pulsaciones repetidas | Un registro y una confirmación; otra presentación del Excel reutiliza el mismo origen. |
| Otra cuenta y nueva sesión | Una operación compartida; los documentos originales no se sobrescriben. |
| Realtime repetido y actualizar Archivo | Las filas se reemplazan sin acumular duplicados. |
| Dos movimientos legítimos | PDF distintos y movimiento explícito del mismo PDF se conservan separados. |
| Históricos duplicados | Comparación completa, decisión admin y archivos originales conservados/accesibles. |
| Confirmación perdida | Reintento tras F5 conserva el mismo ID y una sola consulta. |
| Error de red, datos dañados o permiso revocado | Estado pendiente/verificación; no falsa eliminación; se limpia la vista al revocar. |

No se han comprobado cuentas, documentos ni el canal Realtime de producción después de instalar el SQL, ni dispositivos Android/iPhone físicos. Para verificarlos, realiza una consulta con A, compruébala con B, recarga y vuelve a entrar; después registra un PDF, repite su descarga y actualiza Archivo. Comprueba también una segunda operación real y el detalle desde el teléfono. Las decisiones sobre facturas históricas requieren conocer las operaciones reales.
