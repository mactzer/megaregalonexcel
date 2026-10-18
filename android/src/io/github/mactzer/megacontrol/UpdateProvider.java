package io.github.mactzer.megacontrol;
import android.content.ContentProvider;
import android.content.ContentValues;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.OpenableColumns;
import java.io.File;
import java.io.FileNotFoundException;
/** Read-only, temporary URI grant for the verified APK, never for private business files. */
public final class UpdateProvider extends ContentProvider {
    @Override public boolean onCreate(){return true;}
    private File file(Uri uri)throws FileNotFoundException{if(!"/actualizacion.apk".equals(uri.getPath())||uri.getQuery()!=null)throw new FileNotFoundException();File f=new File(getContext().getCacheDir(),"native-updates/actualizacion.apk");if(!f.isFile())throw new FileNotFoundException();return f;}
    @Override public ParcelFileDescriptor openFile(Uri uri,String mode)throws FileNotFoundException{if(!"r".equals(mode))throw new FileNotFoundException();return ParcelFileDescriptor.open(file(uri),ParcelFileDescriptor.MODE_READ_ONLY);}
    @Override public String getType(Uri uri){return "application/vnd.android.package-archive";}
    @Override public Cursor query(Uri uri,String[] projection,String selection,String[] args,String order){try{File f=file(uri);String[] columns=projection==null?new String[]{OpenableColumns.DISPLAY_NAME,OpenableColumns.SIZE}:projection;MatrixCursor c=new MatrixCursor(columns);Object[] values=new Object[columns.length];for(int i=0;i<columns.length;i++){if(OpenableColumns.DISPLAY_NAME.equals(columns[i]))values[i]="MegaControl.apk";else if(OpenableColumns.SIZE.equals(columns[i]))values[i]=f.length();}c.addRow(values);return c;}catch(Exception e){return null;}}
    @Override public Uri insert(Uri u,ContentValues v){throw new SecurityException("Solo lectura");}
    @Override public int update(Uri u,ContentValues v,String s,String[] a){throw new SecurityException("Solo lectura");}
    @Override public int delete(Uri u,String s,String[] a){throw new SecurityException("Solo lectura");}
}
