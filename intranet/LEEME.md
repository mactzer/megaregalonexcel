# Auditoría compartida dentro de la empresa

Esta versión guarda el historial, los PDF originales y los Excel en **una computadora de la empresa**. Tus compañeros acceden a esa misma computadora mediante la red local. No utiliza una base de datos en la nube y no requiere acceso al servidor central de la empresa.

Necesitas una computadora autorizada para alojarla y una conexión de red que permita a tus compañeros acceder. Esa computadora debe permanecer encendida y el programa debe seguir abierto. Si la empresa no permite alojar un servicio en una computadora ni proporciona otro equipo autorizado, las direcciones IP por sí solas no permiten crear un historial compartido.

## Preparar la computadora que guardará los registros

1. Extrae **todo el ZIP** en una carpeta de esta computadora. Conserva juntos `index.html`, `vendor`, los archivos de auditoría y la carpeta `intranet`. No abras el lanzador dentro del ZIP.
2. Instala **Python 3.10 o posterior**, si no está instalado. En Windows usa el instalador de [python.org](https://www.python.org/downloads/windows/) y activa **Add python.exe to PATH**. No hace falta instalar paquetes con `pip`.
3. En Windows, abre **`iniciar_auditoria.bat`**. En Linux o macOS, abre una terminal en la carpeta extraída y ejecuta `bash iniciar_auditoria.sh`.
4. En el primer inicio, la terminal pide el nombre de la persona, el nombre de usuario y una contraseña de al menos 10 caracteres para la cuenta administradora. Después pide repetir la contraseña. Guarda estos datos: el nombre de la persona se usará para identificar los registros que genere esa cuenta.
5. Abre **http://127.0.0.1:8080/** en el navegador de esa computadora e inicia sesión. Desde el apartado de auditoría, el administrador crea una cuenta distinta para cada compañero.

El lanzador permite conexiones desde la red local en el puerto `8080`. Si ya está ocupado, puedes usar otro puerto, por ejemplo:

```bat
iniciar_auditoria.bat --port 8081
```

En ese caso, cambia también el puerto de las direcciones que compartas. Para detener el servicio, pulsa **Ctrl+C** en su ventana. Al volver a iniciarlo, conserva los registros existentes.

## Dar acceso a tus compañeros

1. En la computadora que está alojando la aplicación, abre **Símbolo del sistema**, ejecuta `ipconfig` y busca la **Dirección IPv4** de la conexión que utiliza la red de la empresa.
2. Comparte una dirección formada con **esa dirección de esa computadora** y el puerto del programa. Por ejemplo, si su IPv4 fuera `192.168.1.80`, sería `http://192.168.1.80:8080/`.
3. Cada compañero abre esa dirección e inicia sesión con su propia cuenta. Todos usan el mismo historial y pueden buscar una salida y descargar sus documentos.

`127.0.0.1` identifica a la computadora en la que se abre el navegador; no sirve como dirección para los compañeros. No uses las direcciones de otros servidores de la empresa para esta instalación.

Si Windows pide permitir acceso de red o la dirección no abre desde otra computadora, solicita al responsable de informática autorización y ayuda para el acceso local. El firewall o la separación entre redes pueden bloquearlo; no cambies esas restricciones sin autorización. Si la IPv4 cambia, tendrás que compartir la dirección nueva o solicitar una dirección estable para este equipo.

## Qué queda registrado

Al descargar un Excel en la versión interna, se guarda una entrada con el número de salida, la cuenta que lo generó, la fecha y hora del servidor, el PDF original y el Excel generado. La interfaz muestra la hora para Panamá. Una salida puede tener varias entradas si se genera más de una vez.

La conversión y el registro funcionan desde la dirección interna de esta versión. El enlace público de **GitHub Pages** sigue siendo el convertidor independiente; no ofrece este historial compartido ni envía documentos a esta computadora.

La aplicación no ofrece editar ni borrar entradas de auditoría. Quien administra la computadora y sus archivos puede modificar el almacenamiento: este historial es un registro operativo, no un sistema de auditoría inalterable.

## Dónde se guardan los documentos

Los datos se guardan por defecto en **`.megaregalonexcel-auditoria`**, dentro de la carpeta personal del usuario que inicia el servidor. En Windows, normalmente es `C:\Users\TU_USUARIO\.megaregalonexcel-auditoria`. Su archivo **`auditoria.sqlite3`** contiene los usuarios, el historial y los PDF y Excel guardados. Las descargas de documentos requieren iniciar sesión; la carpeta de datos no se publica como una carpeta web.

Para elegir otro lugar bajo control de la empresa, inicia el programa con `--data-dir`. Por ejemplo:

```bat
iniciar_auditoria.bat --data-dir "C:\AuditoriaSalidas"
```

Usa una carpeta local autorizada y con espacio suficiente. **No elijas carpetas sincronizadas con OneDrive, Dropbox u otra nube**, ni guardes los datos dentro del repositorio de GitHub. Conserva siempre la misma carpeta al reiniciar o actualizar la aplicación.

## Copias de seguridad

Haz una copia diaria a una ubicación aprobada por la empresa. La opción `--backup` crea el **archivo de respaldo indicado**, que contiene los usuarios, el historial y todos los documentos, y termina sin iniciar otro servidor. Desde la carpeta de la aplicación, por ejemplo:

```bat
py -3 intranet\server.py --backup "D:\RespaldosAuditoria\2026-10-08.sqlite3"
```

Si usas una carpeta de datos personalizada, indica la misma carpeta al hacer el respaldo:

```bat
py -3 intranet\server.py --data-dir "C:\AuditoriaSalidas" --backup "D:\RespaldosAuditoria\2026-10-08.sqlite3"
```

En Linux o macOS, sustituye `py -3` por `python3` y usa rutas de ese sistema. El destino debe permanecer bajo control de la empresa. Revisa que el archivo de respaldo se haya creado antes de depender de él. Cambia la fecha del nombre para conservar copias de varios días; usar el mismo destino reemplaza el respaldo anterior.

Para restaurar un respaldo:

1. Detén el servicio con **Ctrl+C** y conserva una copia de la carpeta de datos actual.
2. Renombra esa carpeta para conservar el estado anterior. Por ejemplo, cambia `.megaregalonexcel-auditoria` a `.megaregalonexcel-auditoria-anterior`. No la borres.
3. Crea una carpeta vacía con el nombre y la ubicación originales de la carpeta de datos.
4. Copia el archivo de respaldo dentro de esa carpeta vacía y cámbiale el nombre a **`auditoria.sqlite3`**. La carpeta nueva evita mezclar el respaldo con los archivos auxiliares de la base anterior.
5. Inicia el servicio con la misma configuración y verifica los usuarios, los registros y la descarga de sus documentos.

## Cifrado de la conexión

**HTTP no cifra las contraseñas ni los documentos durante su recorrido por la red local.** Para utilizar HTTPS, solicita a informática un certificado y su clave que cubran la **dirección IP interna de esta computadora** y sean confiables en los equipos de tus compañeros. Esta versión admite direcciones IP internas y `localhost`; no admite nombres de dominio corporativos. Luego inicia el servidor con ambos archivos:

```bat
iniciar_auditoria.bat --tls-cert "C:\Certificados\auditoria.crt" --tls-key "C:\Certificados\auditoria.key"
```

Abre la dirección IP con `https://` y el puerto correspondiente. Si también quieres abrirla mediante `localhost` o `127.0.0.1`, el certificado debe cubrir esas direcciones. No compartas la clave privada ni la subas al repositorio. El certificado debe coincidir con la dirección utilizada; generar un certificado sin configurar su confianza no hace que los navegadores lo acepten.

## Actualizar sin perder el historial

Detén el servicio, realiza un respaldo y reemplaza los archivos de la aplicación por los de la versión nueva. Conserva la carpeta de datos y usa el mismo `--data-dir`, si lo configuraste. Vuelve a abrir el lanzador y verifica que aparecen tus usuarios y registros anteriores.

Creado por Eddie Rivera. Las condiciones de autoría y uso se encuentran en el README de la aplicación.
