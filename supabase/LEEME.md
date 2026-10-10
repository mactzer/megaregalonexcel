# Auditoría compartida con Supabase

Esta versión utiliza el proyecto **aixsnmsmgyejcbtuilwt**. Se abre desde GitHub Pages y cada persona inicia sesión únicamente con **usuario y contraseña**. No necesita Python ni una computadora interna encendida.

El navegador cifra el PDF, el Excel y los datos comerciales de la salida antes de enviarlos a Supabase. La búsqueda exacta utiliza un índice HMAC, que no guarda el número de salida en texto legible. La contraseña que escribes tampoco se envía: el navegador deriva una credencial de acceso y, por separado, una clave que desbloquea la clave de cifrado del equipo.

**Los archivos cifrados sí salen de la empresa.** Supabase sigue viendo los usuarios, las fechas, los identificadores, la cantidad de registros y el tamaño de los archivos. El cifrado protege el contenido, pero no convierte la nube en almacenamiento interno. Usa esta modalidad con autorización para guardar esa información fuera de la empresa.

La clave pública `anon` puede estar en la página: las reglas de acceso limitan lo que permite cada cuenta. **Nunca incluyas `service_role`, una clave `secret` ni la contraseña de la base de datos en el código o en GitHub.**

## 1. Instalar las tablas y las reglas

1. Abre tu proyecto en el [panel de Supabase](https://supabase.com/dashboard/project/aixsnmsmgyejcbtuilwt).
2. Entra en **SQL Editor → New query**.
3. Copia el contenido completo de [auditoria.sql](auditoria.sql) y pulsa **Run**.

El script crea el espacio de trabajo, las tablas, las funciones y el bucket privado **mega-audit-documents**. No crea cuentas ni permite que cualquier persona registrada entre al historial. Puedes ejecutarlo otra vez sin borrar registros existentes.

## 2. Configurar Supabase Auth

En **Authentication → Sign In / Providers → Email** —el nombre puede variar en el panel— configura:

- **Email provider:** activado.
- **Allow new users to sign up:** activado.
- **Confirm email:** desactivado.

La aplicación utiliza internamente identificadores como `eddie@usuarios.megaregalonexcel.invalid`. **No son correos reales**: el usuario solo escribe `eddie` y su contraseña. Por eso no se envían confirmaciones ni enlaces de recuperación por correo. Dar de alta una cuenta de Auth por sí solo no le concede acceso al historial; necesita aprobación de un administrador.

En **Authentication → URL Configuration**, usa `https://mactzer.github.io/megaregalonexcel/` como **Site URL** y agrega `https://mactzer.github.io/megaregalonexcel/audit.html` en **Redirect URLs**.

## 3. Crear la primera cuenta administradora

1. Abre [Auditoría de salidas](https://mactzer.github.io/megaregalonexcel/audit.html) y crea tu primera cuenta desde la página. Elige un usuario de entre 3 y 32 caracteres; puedes usar letras minúsculas, números, punto, guion y guion bajo. No debe comenzar ni terminar con símbolos, ni contener dos puntos seguidos.
2. Ve a **Authentication → Users** en Supabase y localiza **esa cuenta que acabas de crear**. Verifica su identificador interno, por ejemplo `eddie@usuarios.megaregalonexcel.invalid`. Copia su **User UID**, un UUID parecido a `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`.
3. En SQL Editor, ejecuta este bloque sustituyendo `UUID_DE_TU_CUENTA` por el UID verificado:

```sql
do $$
declare
  v_user_id uuid := 'UUID_DE_TU_CUENTA'::uuid;
begin
  if not exists (select 1 from auth.users
    where id = v_user_id and email_confirmed_at is not null
      and email like '%@usuarios.megaregalonexcel.invalid') then
    raise exception 'Verifica el UID de la cuenta creada desde la página y desactiva Confirm email.';
  end if;
  insert into public.mega_audit_members(workspace_id, user_id, role)
    values ('86551e44-7504-4d30-b453-c9e04b269a43', v_user_id, 'admin')
    on conflict (workspace_id, user_id) do update set role = 'admin';
end;
$$;
```

4. Vuelve a la página e inicia sesión con **el usuario y la contraseña que elegiste allí**. Completa la configuración inicial del historial.

Esta asignación se hace una vez desde el panel del dueño del proyecto. **No selecciones automáticamente la primera cuenta que aparezca:** verifica que sea la tuya antes de otorgar acceso. Crear la cuenta desde el panel con la contraseña habitual no sustituye este paso: la página necesita derivar la credencial y la clave de cifrado. La contraseña antigua de la versión local no se transfiere a Supabase.

## 4. Guardar una copia de recuperación

En la configuración inicial, el navegador genera una clave aleatoria para cifrar los documentos del equipo. La guarda en Supabase únicamente **envuelta con la clave derivada de tu contraseña**, y conserva la clave desbloqueada solo en la memoria de la página. Los usuarios entran con usuario y contraseña; no tienen que escribir una segunda clave.

Como administrador, descarga la **copia de recuperación de la clave** y guárdala en una ubicación protegida aprobada por la empresa. Ese archivo contiene un secreto que permite descifrar los documentos. **No lo subas a GitHub, Supabase ni carpetas compartidas sin protección.**

Perder todas las contraseñas capaces de desbloquear el historial y esa copia impide recuperar los documentos. La copia protege el contenido, pero no es un mecanismo automático de restauración de cuentas en esta versión. La aplicación no cambia la clave del historial por otra porque los registros anteriores dejarían de poder leerse.

## 5. Agregar a tus compañeros

1. Inicia sesión con tu cuenta administradora.
2. Entra en la administración de usuarios.
3. Escribe el usuario y una contraseña inicial para el compañero y selecciona permiso **Usuario**. Utiliza **Administrador** únicamente para quien deba gestionar cuentas.
4. Entrega esos datos al compañero por un medio acordado con la empresa. Cada uno entra con su propia cuenta y consulta el mismo historial.

La cuenta se crea en Auth y el administrador guarda una copia de la clave del equipo envuelta para esa contraseña. Las reglas impiden leer claves envueltas de otros usuarios. Una cuenta de Auth sin aprobación no puede leer el historial ni los documentos.

Al descargar una salida, el sistema guarda su PDF y Excel cifrados y registra la cuenta y la fecha del servidor. La interfaz obtiene la autoría oficial desde el usuario identificado por Supabase; un nombre escrito en los datos del documento no reemplaza esa autoría. La aplicación no ofrece modificar o borrar registros confirmados. Los documentos se descifran en el navegador de la persona autorizada.

## Contraseñas y retirada de acceso

Conserva tu contraseña en un gestor o medio aprobado por la empresa. **No cambies la contraseña directamente en Supabase Auth ni uses la recuperación por correo:** la aplicación emplea una credencial derivada y una clave envuelta vinculada a la contraseña original. Un cambio aislado dejaría el acceso y el descifrado sin sincronizar. La versión actual no incluye recuperación automática ni cambio de contraseña de cuentas existentes.

Para retirar el acceso de una cuenta, como dueño del proyecto entra en SQL Editor y ejecuta este bloque reemplazando el usuario:

```sql
delete from public.mega_audit_members
where workspace_id = '86551e44-7504-4d30-b453-c9e04b269a43'
  and user_id = (select id from auth.users
    where email = lower('USUARIO_A_RETIRAR') || '@usuarios.megaregalonexcel.invalid');
```

Conserva al menos un administrador. No borres desde Auth a un usuario con registros: estos conservan una referencia a su cuenta. Retirar su membresía impide nuevas lecturas mediante Supabase y elimina su copia envuelta de la clave; no elimina archivos ni secretos que ya descargó. Una rotación completa de clave necesitaría volver a cifrar los registros y no forma parte de esta versión.

## Activar precios compartidos del escáner

En un proyecto con la auditoría ya funcionando, el propietario abre **SQL Editor → New query**, copia únicamente [precios.sql](precios.sql) y pulsa **Run**. No repitas la configuración inicial. La actualización conserva cuentas y documentos; es seguro ejecutarla otra vez sin borrar los precios. También puedes usar [el asistente para copiar y activar](https://mactzer.github.io/megaregalonexcel/supabase-precios.html).

Vuelve a la ficha del escáner y pulsa **Comprobar activación**. Un administrador puede usar **Editar precio → Guardar precio**, por ejemplo cambiar 9.99 a 7.99. Los demás miembros verán 7.99 en sus siguientes consultas; la ficha conserva 9.99 como precio original del PDF.

Los precios y códigos se cifran antes de subirlos. Supabase fija la fecha, autor y versión; sólo administradores pueden escribir mediante la función. Los trabajadores pueden consultar, y las políticas de la base de datos impiden que escriban por otra vía. Si otro administrador guardó antes, se exige consultar nuevamente para evitar sobrescribirlo. Un error o un guardado cancelado no se presenta como un cambio confirmado.

La activación necesita los permisos del dueño de Supabase: la clave pública de la aplicación no permite crear tablas. No compartas credenciales en el chat.

## Respaldos y comprobación

Conserva una copia protegida de recuperación y configura respaldos de **la base de datos y los objetos del bucket**: respaldar solo las tablas no incluye los PDF y Excel de Storage. Consulta las opciones del plan de Supabase. Los respaldos de documentos deben conservar el formato cifrado.

Antes de depender del historial, comprueba con un PDF de prueba que dos usuarios aprobados pueden registrar, buscar y descargar la misma salida, y que una cuenta sin aprobación no puede verla. Verifica que el Excel descargado abre correctamente y que el PDF coincide con el original.

El acceso depende de Internet, de que la empresa permita conectarse a `aixsnmsmgyejcbtuilwt.supabase.co`, de las cuotas del plan y de la disponibilidad de Supabase. El historial local anterior no se migra automáticamente. Los administradores del proyecto de Supabase pueden alterar los datos desde su panel: este registro operativo no constituye una auditoría inalterable.

Creado por Eddie Rivera. Las condiciones de autoría y uso están en el README de la aplicación.
