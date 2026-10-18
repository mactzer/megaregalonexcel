package io.github.mactzer.megacontrol;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.provider.Settings;
import android.widget.Toast;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;
import java.util.concurrent.ExecutorService;

/** Signed native APK updates from this repository's releases, with Android confirmation. */
final class Updater {
    private static final String API="https://api.github.com/repos/mactzer/megaregalonexcel/releases?per_page=20";
    private static boolean busy;
    static void check(Activity activity,ExecutorService io,Handler main){
        if(busy)return;busy=true;Toast.makeText(activity,"Buscando actualización…",Toast.LENGTH_SHORT).show();
        io.execute(()->{try{JSONArray releases=new JSONArray(new String(read(API,2*1024*1024),java.nio.charset.StandardCharsets.UTF_8));JSONObject asset=null;String version="";
            for(int i=0;i<releases.length()&&asset==null;i++){JSONObject release=releases.getJSONObject(i);String tag=release.optString("tag_name");if(release.optBoolean("draft")||release.optBoolean("prerelease")||!tag.matches("android-v[0-9]+\\.[0-9]+\\.[0-9]+"))continue;version=tag.substring(9);JSONArray assets=release.getJSONArray("assets");for(int j=0;j<assets.length();j++)if(assets.getJSONObject(j).optString("name").matches("MegaControl-[0-9.]+\\.apk")){asset=assets.getJSONObject(j);break;}}
            final JSONObject download=asset;final String target=version;
            main.post(()->{busy=false;if(activity.isFinishing())return;if(download==null||compare(target,BuildConfig.VERSION_NAME)<=0){new AlertDialog.Builder(activity).setTitle("MegaControl "+BuildConfig.VERSION_NAME).setMessage("Ya tienes la versión nativa más reciente publicada.").setPositiveButton("Aceptar",null).show();return;}
                new AlertDialog.Builder(activity).setTitle("Actualización "+target).setMessage("Se descargará el APK de MegaControl. Se comprobará su firma antes de solicitar a Android que lo instale. Tus documentos permanecen en la base de datos.").setNegativeButton("Después",null).setPositiveButton("Descargar",(d,n)->download(activity,io,main,download)).show();});
        }catch(Exception e){main.post(()->{busy=false;if(!activity.isFinishing())new AlertDialog.Builder(activity).setTitle("No se pudo comprobar la actualización").setMessage("Revisa tu conexión y vuelve a intentarlo. La app actual se conserva.").setPositiveButton("Aceptar",null).show();});}});
    }
    static int compare(String a,String b){String[] x=a.split("\\."),y=b.split("\\.");for(int i=0;i<Math.max(x.length,y.length);i++){int c=Integer.compare(i<x.length?Integer.parseInt(x[i]):0,i<y.length?Integer.parseInt(y[i]):0);if(c!=0)return c;}return 0;}
    static void download(Activity activity,ExecutorService io,Handler main,JSONObject asset){if(busy)return;busy=true;Toast.makeText(activity,"Descargando actualización firmada…",Toast.LENGTH_LONG).show();io.execute(()->{File part=null;try{String url=asset.getString("browser_download_url"),digest=asset.optString("digest","");if(!url.startsWith("https://github.com/mactzer/megaregalonexcel/releases/download/android-v")||!digest.matches("sha256:[a-f0-9]{64}"))throw new Exception("No se pudo verificar la procedencia del APK.");byte[] bytes=read(url,80*1024*1024);if(!digest.substring(7).equals(Crypto.hex(MessageDigest.getInstance("SHA-256").digest(bytes))))throw new Exception("La descarga no coincide con el archivo publicado.");File dir=new File(activity.getCacheDir(),"native-updates");dir.mkdirs();part=File.createTempFile("descargando-",".apk",dir);try(FileOutputStream out=new FileOutputStream(part)){out.write(bytes);}java.util.Arrays.fill(bytes,(byte)0);
                PackageManager pm=activity.getPackageManager();int flags=Build.VERSION.SDK_INT>=28?PackageManager.GET_SIGNING_CERTIFICATES:PackageManager.GET_SIGNATURES;PackageInfo current=pm.getPackageInfo(activity.getPackageName(),flags),next=pm.getPackageArchiveInfo(part.getAbsolutePath(),flags);
                if(next==null||!activity.getPackageName().equals(next.packageName)||versionCode(next)<=versionCode(current)||!sameSignature(current,next))throw new Exception("La firma, la versión o el nombre de la aplicación no coinciden. No se instaló el archivo.");
                File ready=new File(dir,"actualizacion.apk");if(ready.exists()&&!ready.delete())throw new Exception("No se pudo preparar el instalador.");if(!part.renameTo(ready))throw new Exception("No se pudo preparar el instalador.");part=null;
                main.post(()->{busy=false;if(activity.isFinishing())return;install(activity);});
            }catch(Exception e){if(part!=null)part.delete();String message=e.getMessage();main.post(()->{busy=false;if(!activity.isFinishing())new AlertDialog.Builder(activity).setTitle("Actualización no instalada").setMessage(message==null?"No se completó la descarga. Vuelve a intentarlo.":message).setPositiveButton("Aceptar",null).show();});}});}
    static long versionCode(PackageInfo p){return Build.VERSION.SDK_INT>=28?p.getLongVersionCode():p.versionCode;}
    static boolean sameSignature(PackageInfo a,PackageInfo b)throws Exception{Signature[] x=Build.VERSION.SDK_INT>=28?a.signingInfo.getApkContentsSigners():a.signatures,y=Build.VERSION.SDK_INT>=28?b.signingInfo.getApkContentsSigners():b.signatures;if(x==null||y==null||x.length!=1||y.length!=1)return false;return MessageDigest.isEqual(MessageDigest.getInstance("SHA-256").digest(x[0].toByteArray()),MessageDigest.getInstance("SHA-256").digest(y[0].toByteArray()));}
    static void install(Activity activity){File file=new File(activity.getCacheDir(),"native-updates/actualizacion.apk");if(!file.isFile())return;if(!activity.getPackageManager().canRequestPackageInstalls()){new AlertDialog.Builder(activity).setTitle("Permitir actualizaciones de MegaControl").setMessage("Android necesita tu autorización para abrir las actualizaciones firmadas desde esta app. Después podrás confirmar la instalación.").setNegativeButton("Cancelar",null).setPositiveButton("Abrir ajuste",(d,n)->activity.startActivityForResult(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,Uri.parse("package:"+activity.getPackageName())),14)).show();return;}Intent intent=new Intent(Intent.ACTION_VIEW).setDataAndType(Uri.parse("content://"+activity.getPackageName()+".updates/actualizacion.apk"),"application/vnd.android.package-archive").addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);activity.startActivity(intent);}
    static byte[] read(String address,int max)throws Exception{
        URL next=new URL(address);for(int redirects=0;redirects<6;redirects++){if(!next.getProtocol().equals("https")||!(next.getHost().equals("api.github.com")||next.getHost().equals("github.com")||next.getHost().endsWith(".githubusercontent.com")))throw new Exception("Dirección de actualización no autorizada.");HttpURLConnection c=(HttpURLConnection)next.openConnection();c.setConnectTimeout(15000);c.setReadTimeout(30000);c.setInstanceFollowRedirects(false);c.setRequestProperty("User-Agent","MegaControl-Android/"+BuildConfig.VERSION_NAME);try{int status=c.getResponseCode();if(status>=300&&status<400){next=new URL(next,c.getHeaderField("Location"));continue;}if(status!=200)throw new Exception("No se pudo descargar la actualización (HTTP "+status+").");ByteArrayOutputStream out=new ByteArrayOutputStream();try(InputStream in=c.getInputStream()){byte[] buffer=new byte[32768];int n;while((n=in.read(buffer))!=-1){out.write(buffer,0,n);if(out.size()>max)throw new Exception("La actualización supera el tamaño permitido.");}}return out.toByteArray();}finally{c.disconnect();}}throw new Exception("La dirección de actualización tiene demasiadas redirecciones.");
    }
}
