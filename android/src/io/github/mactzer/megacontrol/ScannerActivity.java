package io.github.mactzer.megacontrol;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.ImageFormat;
import android.graphics.Matrix;
import android.graphics.SurfaceTexture;
import android.hardware.camera2.CameraAccessException;
import android.hardware.camera2.CameraCaptureSession;
import android.hardware.camera2.CameraCharacteristics;
import android.hardware.camera2.CameraDevice;
import android.hardware.camera2.CameraManager;
import android.hardware.camera2.CaptureRequest;
import android.hardware.camera2.params.StreamConfigurationMap;
import android.media.Image;
import android.media.ImageReader;
import android.os.Bundle;
import android.os.Handler;
import android.os.HandlerThread;
import android.util.Size;
import android.view.Gravity;
import android.view.Surface;
import android.view.TextureView;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.SeekBar;
import android.widget.TextView;
import com.google.zxing.BarcodeFormat;
import com.google.zxing.BinaryBitmap;
import com.google.zxing.DecodeHintType;
import com.google.zxing.MultiFormatReader;
import com.google.zxing.PlanarYUVLuminanceSource;
import com.google.zxing.Result;
import com.google.zxing.common.HybridBinarizer;
import java.nio.ByteBuffer;
import java.util.Arrays;
import java.util.EnumMap;
import java.util.Map;

/** Camera2 preview and ZXing decoding. No browser, web permissions or WebView. */
public final class ScannerActivity extends Activity {
    TextureView preview;TextView status;HandlerThread worker;Handler handler;
    CameraDevice camera;CameraCaptureSession session;ImageReader reader;CaptureRequest.Builder request;
    CameraCharacteristics characteristics;String cameraId;Size imageSize;
    volatile boolean finishing,decoding;boolean torch,opening;long lastDecode;
    final MultiFormatReader decoder=new MultiFormatReader();
    @Override public void onCreate(Bundle b){super.onCreate(b);
        Map<DecodeHintType,Object> hints=new EnumMap<>(DecodeHintType.class);hints.put(DecodeHintType.POSSIBLE_FORMATS,Arrays.asList(BarcodeFormat.CODE_128,BarcodeFormat.EAN_13,BarcodeFormat.EAN_8,BarcodeFormat.UPC_A,BarcodeFormat.UPC_E,BarcodeFormat.CODE_39,BarcodeFormat.ITF));hints.put(DecodeHintType.TRY_HARDER,true);decoder.setHints(hints);
        FrameLayout root=new FrameLayout(this);root.setBackgroundColor(0xff102e2a);root.setFitsSystemWindows(true);preview=new TextureView(this);root.addView(preview,new FrameLayout.LayoutParams(-1,-1));
        LinearLayout controls=new LinearLayout(this);controls.setOrientation(LinearLayout.VERTICAL);controls.setPadding(22,18,22,24);controls.setBackgroundColor(0xdd102e2a);
        status=new TextView(this);status.setTextColor(-1);status.setTextSize(17);status.setText("Centra el código completo y evita reflejos.");controls.addView(status);
        SeekBar zoom=new SeekBar(this);zoom.setMax(100);zoom.setContentDescription("Zoom de cámara");controls.addView(zoom);zoom.setOnSeekBarChangeListener(new SeekBar.OnSeekBarChangeListener(){public void onStartTrackingTouch(SeekBar s){}public void onStopTrackingTouch(SeekBar s){}public void onProgressChanged(SeekBar s,int n,boolean user){if(user&&request!=null&&characteristics!=null){Float max=characteristics.get(CameraCharacteristics.SCALER_AVAILABLE_MAX_DIGITAL_ZOOM);android.graphics.Rect sensor=characteristics.get(CameraCharacteristics.SENSOR_INFO_ACTIVE_ARRAY_SIZE);if(max!=null&&sensor!=null){float factor=1+(Math.min(max,4)-1)*n/100;int w=(int)(sensor.width()/factor),h=(int)(sensor.height()/factor);request.set(CaptureRequest.SCALER_CROP_REGION,new android.graphics.Rect(sensor.centerX()-w/2,sensor.centerY()-h/2,sensor.centerX()+w/2,sensor.centerY()+h/2));repeat();}}}});
        LinearLayout buttons=new LinearLayout(this);Button flash=new Button(this);flash.setText("Linterna");flash.setOnClickListener(v->{if(request!=null&&Boolean.TRUE.equals(characteristics.get(CameraCharacteristics.FLASH_INFO_AVAILABLE))){torch=!torch;request.set(CaptureRequest.FLASH_MODE,torch?CaptureRequest.FLASH_MODE_TORCH:CaptureRequest.FLASH_MODE_OFF);repeat();}else status.setText("La cámara no dispone de linterna.");});buttons.addView(flash,new LinearLayout.LayoutParams(0,-2,1));Button cancel=new Button(this);cancel.setText("Volver");cancel.setOnClickListener(v->finish());buttons.addView(cancel,new LinearLayout.LayoutParams(0,-2,1));controls.addView(buttons);root.addView(controls,new FrameLayout.LayoutParams(-1,-2,Gravity.BOTTOM));setContentView(root);
        preview.setSurfaceTextureListener(new TextureView.SurfaceTextureListener(){public void onSurfaceTextureAvailable(SurfaceTexture t,int w,int h){open();}public void onSurfaceTextureSizeChanged(SurfaceTexture t,int w,int h){transform();}public boolean onSurfaceTextureDestroyed(SurfaceTexture t){return true;}public void onSurfaceTextureUpdated(SurfaceTexture t){}});
    }
    @Override protected void onResume(){super.onResume();finishing=false;worker=new HandlerThread("MegaControl-camara");worker.start();handler=new Handler(worker.getLooper());if(checkSelfPermission(Manifest.permission.CAMERA)!=PackageManager.PERMISSION_GRANTED)requestPermissions(new String[]{Manifest.permission.CAMERA},1);else if(preview.isAvailable())open();}
    @Override public void onRequestPermissionsResult(int code,String[] p,int[] results){super.onRequestPermissionsResult(code,p,results);if(code==1){if(results.length>0&&results[0]==PackageManager.PERMISSION_GRANTED)open();else{setResult(RESULT_CANCELED);finish();}}}
    void open(){if(camera!=null||opening||finishing||handler==null||!preview.isAvailable()||checkSelfPermission(Manifest.permission.CAMERA)!=PackageManager.PERMISSION_GRANTED)return;opening=true;
        try{CameraManager manager=(CameraManager)getSystemService(CAMERA_SERVICE);for(String id:manager.getCameraIdList()){CameraCharacteristics c=manager.getCameraCharacteristics(id);if(Integer.valueOf(CameraCharacteristics.LENS_FACING_BACK).equals(c.get(CameraCharacteristics.LENS_FACING))){cameraId=id;characteristics=c;break;}}if(cameraId==null)throw new Exception("No se encontró la cámara trasera.");
            StreamConfigurationMap map=characteristics.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP);Size[] sizes=map.getOutputSizes(ImageFormat.YUV_420_888);imageSize=sizes[0];long best=Long.MAX_VALUE;for(Size size:sizes){long score=Math.abs((long)size.getWidth()*size.getHeight()-1280L*720);if(size.getWidth()<=1920&&size.getHeight()<=1080&&score<best){best=score;imageSize=size;}}
            reader=ImageReader.newInstance(imageSize.getWidth(),imageSize.getHeight(),ImageFormat.YUV_420_888,2);reader.setOnImageAvailableListener(r->{Image image=null;try{image=r.acquireLatestImage();if(image==null||finishing||decoding||android.os.SystemClock.elapsedRealtime()-lastDecode<120)return;lastDecode=android.os.SystemClock.elapsedRealtime();decoding=true;decode(image);}catch(IllegalStateException ignored){}finally{decoding=false;if(image!=null)image.close();}},handler);
            manager.openCamera(cameraId,new CameraDevice.StateCallback(){public void onOpened(CameraDevice c){opening=false;if(finishing){c.close();return;}camera=c;startPreview();}public void onDisconnected(CameraDevice c){opening=false;c.close();camera=null;}public void onError(CameraDevice c,int error){opening=false;c.close();camera=null;runOnUiThread(()->status.setText("No se pudo iniciar la cámara. Vuelve y prueba una foto de la etiqueta."));}},handler);
        }catch(Exception e){opening=false;status.setText(e.getMessage()==null?"No se pudo abrir la cámara.":e.getMessage());}
    }
    void startPreview(){try{SurfaceTexture texture=preview.getSurfaceTexture();texture.setDefaultBufferSize(imageSize.getWidth(),imageSize.getHeight());Surface surface=new Surface(texture);request=camera.createCaptureRequest(CameraDevice.TEMPLATE_PREVIEW);request.addTarget(surface);request.addTarget(reader.getSurface());request.set(CaptureRequest.CONTROL_AF_MODE,CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_PICTURE);request.set(CaptureRequest.CONTROL_AE_MODE,CaptureRequest.CONTROL_AE_MODE_ON);
        camera.createCaptureSession(Arrays.asList(surface,reader.getSurface()),new CameraCaptureSession.StateCallback(){public void onConfigured(CameraCaptureSession s){if(finishing){s.close();return;}session=s;repeat();runOnUiThread(()->transform());}public void onConfigureFailed(CameraCaptureSession s){runOnUiThread(()->status.setText("No se pudo preparar la cámara."));}},handler);
    }catch(Exception e){runOnUiThread(()->status.setText("No se pudo preparar la cámara."));}}
    void repeat(){try{if(session!=null&&request!=null&&!finishing)session.setRepeatingRequest(request.build(),null,handler);}catch(Exception ignored){}}
    void transform(){if(imageSize==null)return;int sensor=characteristics.get(CameraCharacteristics.SENSOR_ORIENTATION);int device=getWindowManager().getDefaultDisplay().getRotation()*90;int rotation=(sensor-device+360)%360;Matrix matrix=new Matrix();float cx=preview.getWidth()/2f,cy=preview.getHeight()/2f;
        // Rotate the landscape camera buffer to a portrait preview without stretching bars.
        android.graphics.RectF view=new android.graphics.RectF(0,0,preview.getWidth(),preview.getHeight()),buffer=new android.graphics.RectF(0,0,rotation%180==0?imageSize.getWidth():imageSize.getHeight(),rotation%180==0?imageSize.getHeight():imageSize.getWidth());buffer.offset(cx-buffer.centerX(),cy-buffer.centerY());matrix.setRectToRect(view,buffer,Matrix.ScaleToFit.FILL);float scale=Math.max(preview.getWidth()/buffer.width(),preview.getHeight()/buffer.height());matrix.postScale(scale,scale,cx,cy);matrix.postRotate(rotation,cx,cy);preview.setTransform(matrix);
    }
    void decode(Image image){try{int w=image.getWidth(),h=image.getHeight();Image.Plane plane=image.getPlanes()[0];ByteBuffer buffer=plane.getBuffer();byte[] y=new byte[w*h];int stride=plane.getRowStride(),pixel=plane.getPixelStride();for(int row=0;row<h;row++)for(int x=0;x<w;x++){int i=row*stride+x*pixel;if(i<buffer.limit())y[row*w+x]=buffer.get(i);}
        Result result=read(y,w,h);if(result==null){byte[] rotated=new byte[y.length];for(int row=0;row<h;row++)for(int x=0;x<w;x++)rotated[x*h+(h-row-1)]=y[row*w+x];result=read(rotated,h,w);}if(result!=null&&!finishing){finishing=true;String code=result.getText();runOnUiThread(()->{setResult(RESULT_OK,new Intent().putExtra("code",code));finish();});}
    }catch(Exception ignored){}}
    Result read(byte[] y,int w,int h){PlanarYUVLuminanceSource source=new PlanarYUVLuminanceSource(y,w,h,0,0,w,h,false);try{return decoder.decodeWithState(new BinaryBitmap(new HybridBinarizer(source)));}catch(Exception ignored){try{return decoder.decodeWithState(new BinaryBitmap(new HybridBinarizer(source.invert())));}catch(Exception nothing){return null;}}finally{decoder.reset();}}
    @Override protected void onPause(){finishing=true;opening=false;if(session!=null){session.close();session=null;}if(camera!=null){camera.close();camera=null;}if(reader!=null){reader.close();reader=null;}if(worker!=null){worker.quitSafely();worker=null;handler=null;}super.onPause();}
}
