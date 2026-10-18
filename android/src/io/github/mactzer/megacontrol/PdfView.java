package io.github.mactzer.megacontrol;
import android.app.Activity;
import android.app.Dialog;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.graphics.Matrix;
import android.graphics.pdf.PdfRenderer;
import android.os.ParcelFileDescriptor;
import android.view.ScaleGestureDetector;
import android.view.MotionEvent;
import android.widget.Button;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;
import java.io.File;
import java.io.FileOutputStream;
import java.util.Arrays;
final class PdfView {
    static void open(Activity activity,byte[] bytes)throws Exception{
        File file=File.createTempFile("megacontrol-pdf-",".pdf",activity.getCacheDir());
        try(FileOutputStream out=new FileOutputStream(file)){out.write(bytes);}finally{Arrays.fill(bytes,(byte)0);}
        ParcelFileDescriptor descriptor=ParcelFileDescriptor.open(file,ParcelFileDescriptor.MODE_READ_ONLY);PdfRenderer renderer=new PdfRenderer(descriptor);
        Dialog dialog=new Dialog(activity,android.R.style.Theme_Material_Light_NoActionBar);LinearLayout root=new LinearLayout(activity);root.setOrientation(LinearLayout.VERTICAL);root.setFitsSystemWindows(true);ImageView image=new ImageView(activity);image.setScaleType(ImageView.ScaleType.MATRIX);root.addView(image,new LinearLayout.LayoutParams(-1,0,1));LinearLayout controls=new LinearLayout(activity);Button previous=new Button(activity),next=new Button(activity),close=new Button(activity);previous.setText("Anterior");next.setText("Siguiente");close.setText("Cerrar");TextView label=new TextView(activity);controls.addView(previous);controls.addView(label,new LinearLayout.LayoutParams(0,-2,1));controls.addView(next);controls.addView(close);root.addView(controls);int[] page={0};Bitmap[] bitmap={null};Matrix matrix=new Matrix();
        Runnable render=()->{PdfRenderer.Page p=renderer.openPage(page[0]);float scale=Math.min(2.5f,2200f/Math.max(p.getWidth(),p.getHeight()));Bitmap fresh=Bitmap.createBitmap(Math.max(1,(int)(p.getWidth()*scale)),Math.max(1,(int)(p.getHeight()*scale)),Bitmap.Config.ARGB_8888);fresh.eraseColor(Color.WHITE);p.render(fresh,null,null,PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY);p.close();image.setImageBitmap(fresh);if(bitmap[0]!=null)bitmap[0].recycle();bitmap[0]=fresh;matrix.reset();float fit=activity.getResources().getDisplayMetrics().widthPixels/(float)fresh.getWidth();matrix.postScale(fit,fit);image.setImageMatrix(matrix);label.setText(" "+(page[0]+1)+" / "+renderer.getPageCount()+" ");previous.setEnabled(page[0]>0);next.setEnabled(page[0]<renderer.getPageCount()-1);};
        ScaleGestureDetector zoom=new ScaleGestureDetector(activity,new ScaleGestureDetector.SimpleOnScaleGestureListener(){@Override public boolean onScale(ScaleGestureDetector d){matrix.postScale(d.getScaleFactor(),d.getScaleFactor(),d.getFocusX(),d.getFocusY());image.setImageMatrix(matrix);return true;}});float[] touch={0,0};image.setOnTouchListener((v,event)->{zoom.onTouchEvent(event);if(event.getActionMasked()==MotionEvent.ACTION_DOWN){touch[0]=event.getX();touch[1]=event.getY();}else if(event.getActionMasked()==MotionEvent.ACTION_MOVE&&!zoom.isInProgress()){matrix.postTranslate(event.getX()-touch[0],event.getY()-touch[1]);image.setImageMatrix(matrix);touch[0]=event.getX();touch[1]=event.getY();}return true;});previous.setOnClickListener(v->{page[0]--;render.run();});next.setOnClickListener(v->{page[0]++;render.run();});close.setOnClickListener(v->dialog.dismiss());dialog.setOnDismissListener(d->{image.setImageDrawable(null);if(bitmap[0]!=null)bitmap[0].recycle();renderer.close();try{descriptor.close();}catch(Exception ignored){}file.delete();});dialog.setContentView(root);dialog.show();render.run();
    }
}
