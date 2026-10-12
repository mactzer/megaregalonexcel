# Respaldos locales de MegaControl

En Chrome o Edge de computadora, entra como administrador y abre **Perfil → Respaldos**.
Escribe una contraseña larga, repítela y pulsa **Guardar o actualizar respaldo**. Selecciona
una carpeta privada, inicialmente vacía. Conserva la contraseña y la carpeta completa.
La contraseña puede ser diferente de la de tu cuenta y se utiliza solo en tu navegador.

El primer respaldo descarga todos los documentos. Al elegir la misma carpeta y contraseña,
los siguientes solo descargan los nuevos o dañados. Los datos pequeños de la base se
actualizan completos. No crea tablas, tareas automáticas ni copias adicionales en Supabase.
Consume la transferencia de las descargas; hazlo al terminar la jornada.

Incluye salidas y duplicados, PDF, Excel, precios actuales, consultas compartidas,
operaciones, miembros, claves envueltas, autoría y la clave de recuperación. Conserva
también documentos pendientes de registro. Datos, nombres y clave de recuperación quedan
cifrados. No contiene tokens, sesiones ni contraseñas de Supabase Auth.

**Verificar respaldo** comprueba hashes y descifra realmente documentos y metadatos.
Cada actualización conserva el manifiesto anterior. Los documentos se identifican por
su huella, por lo que una interrupción no reemplaza documentos anteriores.
No elimina versiones antiguas locales: el espacio utilizado queda en tu computadora.

## Recuperar sin internet

1. Abre `recuperar.html` dentro del respaldo, en Chrome o Edge de computadora.
2. Escribe la contraseña y pulsa **Verificar respaldo**; selecciona la carpeta completa.
3. Pulsa **Recuperar archivos y datos** y selecciona el respaldo. Después de verificarlo,
   pulsa **Elegir destino y recuperar**.
4. Se crea `MegaControl-recuperado-...` con PDF y Excel originales, datos legibles,
   datos completos de la base, inventario, copias cifradas de Storage y `clave-privada.txt`.
   Los identificadores conservan qué archivo pertenece a cada salida.
5. Si el último guardado se interrumpió, marca **Usar el respaldo anterior**.

La herramienta no hace peticiones de red. **La carpeta recuperada contiene datos descifrados
y una clave privada**: protégela y no la subas a GitHub. Recuperar en la computadora no
cambia la base activa.

## Restaurar faltantes en el proyecto original

Corresponde al dueño del proyecto. Requiere las tablas instaladas y las mismas identidades
de Supabase Auth. Una pérdida del proyecto entero requiere recuperar o restablecer las
cuentas por separado; este respaldo no guarda sus contraseñas.

[tools/restore-megacontrol.py](../tools/restore-megacontrol.py) usa exclusivamente el proyecto
original de MegaControl y requiere Python 3 y `MEGACONTROL_SUPABASE_ACCESS_TOKEN`
configurada fuera del repositorio. Primero realiza una simulación de solo lectura:

```sh
python3 tools/restore-megacontrol.py "/ruta/MegaControl-recuperado-..."
```

Después de revisar el resultado, restaura únicamente los archivos y filas faltantes:

```sh
python3 tools/restore-megacontrol.py "/ruta/MegaControl-recuperado-..." --apply
```

La herramienta compara las huellas de archivos existentes y se detiene si son diferentes.
Nunca sobrescribe ni borra documentos. Inserta filas faltantes en una transacción y conserva
las existentes, incluidos precios y permisos posteriores al respaldo. Conserva identidad y
fecha originales. Puedes repetirla tras una interrupción. Un fallo antes de insertar puede
dejar archivos cifrados todavía sin registro; no elimina originales. Esta restauración no
revierte precios existentes: eso corresponde al historial de precios.

Por defecto no restaura permisos ni claves por usuario, para evitar aprobar de nuevo a una
persona revocada después de crear la copia. Solo si se necesita recuperar los accesos de un
equipo perdido, el dueño puede añadir `--restore-access`; inserta membresías y claves faltantes,
sin sustituir las existentes. La clave privada recuperada permite volver a configurar los accesos.

## Activación y pruebas

Aplica únicamente [respaldos.sql](respaldos.sql) sobre el proyecto existente. Es aditivo y
repetible: añade una función de lectura exclusiva para administradores. La instantánea se
lee una sola vez por respaldo, no periódicamente.

Las pruebas usan documentos ficticios, cifrado real, directorios locales y PostgreSQL.
Verifican bytes originales, actualizaciones sin volver a descargar, contraseña equivocada,
corrupción, interrupciones, permisos y restauración transaccional. No restauran ni borran
datos de producción durante la verificación.
