package io.github.mactzer.megacontrol;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.ImageFormat;
import android.graphics.Matrix;
import android.graphics.SurfaceTexture;
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
  TextureView preview;
  TextView status;
  HandlerThread worker;
  Handler handler;
  CameraDevice camera;
  CameraCaptureSession session;
  ImageReader reader;
  CaptureRequest.Builder request;
  CameraCharacteristics characteristics;
  String cameraId;
  Size imageSize;
  volatile boolean finishing, decoding;
  boolean torch, opening;
  long lastDecode;
  int previewFrames;
  FrameLayout previewFrame;
  Button flash;
  final java.util.List<Button> zoomButtons = new java.util.ArrayList<>();
  float zoomFactor = 1;
  final MultiFormatReader decoder = new MultiFormatReader();

  @Override
  public void onCreate(Bundle b) {
    super.onCreate(b);
    Map<DecodeHintType, Object> hints = new EnumMap<>(DecodeHintType.class);
    hints.put(
        DecodeHintType.POSSIBLE_FORMATS,
        Arrays.asList(
            BarcodeFormat.CODE_128,
            BarcodeFormat.EAN_13,
            BarcodeFormat.EAN_8,
            BarcodeFormat.UPC_A,
            BarcodeFormat.UPC_E,
            BarcodeFormat.CODE_39,
            BarcodeFormat.ITF));
    hints.put(DecodeHintType.TRY_HARDER, true);
    decoder.setHints(hints);
    LinearLayout root = new LinearLayout(this);
    root.setOrientation(LinearLayout.VERTICAL);
    root.setBackgroundColor(Ui.DARK);
    root.setFitsSystemWindows(true);
    getWindow().setStatusBarColor(Ui.DARK);
    getWindow().setNavigationBarColor(Ui.DARK);
    if (android.os.Build.VERSION.SDK_INT >= 30) {
      getWindow().setDecorFitsSystemWindows(false);
      root.setOnApplyWindowInsetsListener(
          (v, insets) -> {
            android.graphics.Insets x =
                insets.getInsets(android.view.WindowInsets.Type.systemBars());
            v.setPadding(x.left, x.top, x.right, x.bottom);
            return insets;
          });
      root.post(
          () -> {
            android.view.WindowInsetsController controller = getWindow().getInsetsController();
            if (controller != null)
              controller.setSystemBarsAppearance(
                  0,
                  android.view.WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS
                      | android.view.WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS);
          });
    }
    LinearLayout top = new LinearLayout(this);
    top.setGravity(Gravity.CENTER_VERTICAL);
    top.setPadding(dp(10), dp(12), dp(12), dp(12));
    top.addView(
        Ui.iconButton(
            this, "back", "Volver", android.graphics.Color.WHITE, 0x14ffffff, () -> finish()));
    LinearLayout title = new LinearLayout(this);
    title.setOrientation(LinearLayout.VERTICAL);
    title.setPadding(dp(14), 0, 0, 0);
    android.widget.TextView heading =
        Ui.label(this, "Escanear producto", 19, android.graphics.Color.WHITE);
    Ui.bold(heading);
    title.addView(heading);
    android.widget.TextView subtitle = Ui.label(this, "Lectura automática", 12, 0xffb7dac8);
    title.addView(subtitle);
    top.addView(title, new LinearLayout.LayoutParams(0, -2, 1));
    top.addView(
        Ui.iconButton(
            this,
            "photo",
            "Leer desde una foto",
            android.graphics.Color.WHITE,
            0x14ffffff,
            () -> {
              setResult(RESULT_OK, new Intent().putExtra("choosePhoto", true));
              finish();
            }));
    root.addView(top);
    previewFrame = new FrameLayout(this);
    previewFrame.setClipChildren(true);
    previewFrame.setBackgroundColor(0xff081b16);
    preview = new TextureView(this);
    previewFrame.addView(preview, new FrameLayout.LayoutParams(-1, -1));
    previewFrame.addView(new Finder(this), new FrameLayout.LayoutParams(-1, -1));
    root.addView(previewFrame, new LinearLayout.LayoutParams(-1, 0, 1));
    LinearLayout controls = new LinearLayout(this);
    controls.setOrientation(LinearLayout.VERTICAL);
    controls.setPadding(dp(24), dp(20), dp(24), dp(18));
    status = Ui.label(this, "Preparando cámara…", 16, android.graphics.Color.WHITE);
    Ui.bold(status);
    status.setGravity(Gravity.CENTER);
    controls.addView(status);
    android.widget.TextView help =
        Ui.label(this, "Incluye todas las barras y evita reflejos.", 12, 0xffb7d1c2);
    help.setGravity(Gravity.CENTER);
    LinearLayout.LayoutParams helpLp = new LinearLayout.LayoutParams(-1, -2);
    helpLp.topMargin = dp(6);
    helpLp.bottomMargin = dp(16);
    controls.addView(help, helpLp);
    LinearLayout zoomRow = new LinearLayout(this);
    zoomRow.setGravity(Gravity.CENTER);
    for (int factor : new int[] {1, 2, 3}) {
      Button option = Ui.action(this, factor + "×", null, false, () -> setZoom(factor));
      option.setTextSize(13);
      option.setBackground(Ui.ripple(this, factor == 1 ? 0xffd7eee0 : 0xff245246, 22));
      option.setTextColor(factor == 1 ? Ui.DARK : android.graphics.Color.WHITE);
      LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(dp(56), dp(44));
      lp.setMargins(dp(4), 0, dp(4), 0);
      zoomRow.addView(option, lp);
      zoomButtons.add(option);
    }
    controls.addView(zoomRow);
    flash = Ui.action(this, "Encender linterna", "flash", false, () -> toggleTorch());
    flash.setBackground(Ui.ripple(this, 0xff245246, 16));
    flash.setTextColor(android.graphics.Color.WHITE);
    flash.setCompoundDrawablesRelativeWithIntrinsicBounds(
        new Ui.Icon(this, "flash", android.graphics.Color.WHITE, 19), null, null, null);
    LinearLayout.LayoutParams flashLp = new LinearLayout.LayoutParams(-1, dp(50));
    flashLp.topMargin = dp(18);
    controls.addView(flash, flashLp);
    root.addView(controls);
    setContentView(root);
    preview.setSurfaceTextureListener(
        new TextureView.SurfaceTextureListener() {
          public void onSurfaceTextureAvailable(SurfaceTexture t, int w, int h) {
            open();
          }

          public void onSurfaceTextureSizeChanged(SurfaceTexture t, int w, int h) {
            transform();
          }

          public boolean onSurfaceTextureDestroyed(SurfaceTexture t) {
            return true;
          }

          public void onSurfaceTextureUpdated(SurfaceTexture t) {
            previewFrames++;
          }
        });
  }

  @Override
  protected void onResume() {
    super.onResume();
    finishing = false;
    worker = new HandlerThread("MegaControl-camara");
    worker.start();
    handler = new Handler(worker.getLooper());
    if (checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED)
      requestPermissions(new String[] {Manifest.permission.CAMERA}, 1);
    else if (preview.isAvailable()) open();
  }

  @Override
  public void onRequestPermissionsResult(int code, String[] p, int[] results) {
    super.onRequestPermissionsResult(code, p, results);
    if (code == 1) {
      if (results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED) open();
      else {
        setResult(RESULT_CANCELED);
        finish();
      }
    }
  }

  void open() {
    if (camera != null
        || opening
        || finishing
        || handler == null
        || !preview.isAvailable()
        || checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED)
      return;
    opening = true;
    try {
      CameraManager manager = (CameraManager) getSystemService(CAMERA_SERVICE);
      for (String id : manager.getCameraIdList()) {
        CameraCharacteristics c = manager.getCameraCharacteristics(id);
        if (Integer.valueOf(CameraCharacteristics.LENS_FACING_BACK)
            .equals(c.get(CameraCharacteristics.LENS_FACING))) {
          cameraId = id;
          characteristics = c;
          break;
        }
      }
      if (cameraId == null) throw new Exception("No se encontró la cámara trasera.");
      StreamConfigurationMap map =
          characteristics.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP);
      Size[] sizes = map.getOutputSizes(ImageFormat.YUV_420_888);
      java.util.List<Size> previewSizes = Arrays.asList(map.getOutputSizes(SurfaceTexture.class));
      imageSize = null;
      long best = Long.MAX_VALUE;
      for (Size size : sizes) {
        long score = Math.abs((long) size.getWidth() * size.getHeight() - 1280L * 720);
        if (previewSizes.contains(size)
            && size.getWidth() <= 1920
            && size.getHeight() <= 1080
            && score < best) {
          best = score;
          imageSize = size;
        }
      }
      if (imageSize == null) throw new Exception("No se encontró un tamaño de cámara compatible.");
      reader =
          ImageReader.newInstance(
              imageSize.getWidth(), imageSize.getHeight(), ImageFormat.YUV_420_888, 2);
      reader.setOnImageAvailableListener(
          r -> {
            Image image = null;
            try {
              image = r.acquireLatestImage();
              if (image == null
                  || finishing
                  || decoding
                  || android.os.SystemClock.elapsedRealtime() - lastDecode < 120) return;
              lastDecode = android.os.SystemClock.elapsedRealtime();
              decoding = true;
              decode(image);
            } catch (IllegalStateException ignored) {
            } finally {
              decoding = false;
              if (image != null) image.close();
            }
          },
          handler);
      manager.openCamera(
          cameraId,
          new CameraDevice.StateCallback() {
            public void onOpened(CameraDevice c) {
              opening = false;
              if (finishing) {
                c.close();
                return;
              }
              camera = c;
              startPreview();
            }

            public void onDisconnected(CameraDevice c) {
              opening = false;
              c.close();
              camera = null;
            }

            public void onError(CameraDevice c, int error) {
              opening = false;
              c.close();
              camera = null;
              runOnUiThread(
                  () ->
                      status.setText(
                          "No se pudo iniciar la cámara. Vuelve y prueba una foto de la"
                              + " etiqueta."));
            }
          },
          handler);
    } catch (Exception e) {
      opening = false;
      status.setText(e.getMessage() == null ? "No se pudo abrir la cámara." : e.getMessage());
    }
  }

  void startPreview() {
    try {
      SurfaceTexture texture = preview.getSurfaceTexture();
      texture.setDefaultBufferSize(imageSize.getWidth(), imageSize.getHeight());
      Surface surface = new Surface(texture);
      request = camera.createCaptureRequest(CameraDevice.TEMPLATE_PREVIEW);
      request.addTarget(surface);
      request.addTarget(reader.getSurface());
      int focus = CaptureRequest.CONTROL_AF_MODE_OFF;
      int[] focusModes = characteristics.get(CameraCharacteristics.CONTROL_AF_AVAILABLE_MODES);
      if (focusModes != null)
        for (int mode : focusModes)
          if (mode == CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_PICTURE) focus = mode;
      request.set(CaptureRequest.CONTROL_AF_MODE, focus);
      request.set(CaptureRequest.CONTROL_AE_MODE, CaptureRequest.CONTROL_AE_MODE_ON);
      camera.createCaptureSession(
          Arrays.asList(surface, reader.getSurface()),
          new CameraCaptureSession.StateCallback() {
            public void onConfigured(CameraCaptureSession s) {
              if (finishing) {
                s.close();
                return;
              }
              session = s;
              repeat();
              runOnUiThread(
                  () -> {
                    transform();
                    setZoom(zoomFactor);
                    status.setText("Coloca el código dentro del marco");
                  });
            }

            public void onConfigureFailed(CameraCaptureSession s) {
              runOnUiThread(() -> status.setText("No se pudo preparar la cámara."));
            }
          },
          handler);
    } catch (Exception e) {
      runOnUiThread(() -> status.setText("No se pudo preparar la cámara."));
    }
  }

  void repeat() {
    try {
      if (session != null && request != null && !finishing)
        session.setRepeatingRequest(request.build(), null, handler);
    } catch (Exception ignored) {
    }
  }

  int dp(int n) {
    return Ui.dp(this, n);
  }

  void transform() {
    if (imageSize == null
        || characteristics == null
        || preview.getWidth() == 0
        || preview.getHeight() == 0) return;
    Integer sensor = characteristics.get(CameraCharacteristics.SENSOR_ORIENTATION);
    int display = getWindowManager().getDefaultDisplay().getRotation() * 90;
    Matrix matrix = new Matrix();
    matrix.setValues(
        CameraGeometry.textureTransform(
            preview.getWidth(),
            preview.getHeight(),
            imageSize.getWidth(),
            imageSize.getHeight(),
            sensor == null ? 90 : sensor,
            display));
    preview.setTransform(matrix);
  }

  void setZoom(float requested) {
    if (request == null || characteristics == null) return;
    Float maximum = characteristics.get(CameraCharacteristics.SCALER_AVAILABLE_MAX_DIGITAL_ZOOM);
    android.graphics.Rect sensor =
        characteristics.get(CameraCharacteristics.SENSOR_INFO_ACTIVE_ARRAY_SIZE);
    if (maximum == null || sensor == null) return;
    zoomFactor = Math.max(1, Math.min(requested, maximum));
    int w = Math.max(1, (int) (sensor.width() / zoomFactor)),
        h = Math.max(1, (int) (sensor.height() / zoomFactor));
    request.set(
        CaptureRequest.SCALER_CROP_REGION,
        new android.graphics.Rect(
            sensor.centerX() - w / 2,
            sensor.centerY() - h / 2,
            sensor.centerX() + w / 2,
            sensor.centerY() + h / 2));
    repeat();
    for (int i = 0; i < zoomButtons.size(); i++) {
      boolean selected = Math.abs(zoomFactor - (i + 1)) < .05;
      Button option = zoomButtons.get(i);
      option.setEnabled(maximum >= i + 1);
      option.setBackground(Ui.ripple(this, selected ? 0xffd7eee0 : 0xff245246, 22));
      option.setTextColor(selected ? Ui.DARK : android.graphics.Color.WHITE);
      option.setSelected(selected);
    }
  }

  void toggleTorch() {
    if (request == null || characteristics == null) return;
    if (!Boolean.TRUE.equals(characteristics.get(CameraCharacteristics.FLASH_INFO_AVAILABLE))) {
      status.setText("Esta cámara no tiene linterna.");
      return;
    }
    torch = !torch;
    request.set(
        CaptureRequest.FLASH_MODE,
        torch ? CaptureRequest.FLASH_MODE_TORCH : CaptureRequest.FLASH_MODE_OFF);
    repeat();
    flash.setText(torch ? "Apagar linterna" : "Encender linterna");
    flash.setSelected(torch);
  }

  static final class Finder extends android.view.View {
    final android.graphics.Paint paint =
        new android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG);

    Finder(android.content.Context context) {
      super(context);
      setImportantForAccessibility(IMPORTANT_FOR_ACCESSIBILITY_NO);
    }

    @Override
    protected void onDraw(android.graphics.Canvas canvas) {
      float w = getWidth(),
          h = getHeight(),
          left = w * .09f,
          right = w * .91f,
          half = Math.min(Ui.dp(getContext(), 75), h * .23f),
          top = h * .47f - half,
          bottom = h * .47f + half;
      paint.setStyle(android.graphics.Paint.Style.FILL);
      paint.setColor(0x79061712);
      canvas.drawRect(0, 0, w, top, paint);
      canvas.drawRect(0, bottom, w, h, paint);
      canvas.drawRect(0, top, left, bottom, paint);
      canvas.drawRect(right, top, w, bottom, paint);
      paint.setColor(0xffb5f3ce);
      paint.setStyle(android.graphics.Paint.Style.STROKE);
      paint.setStrokeWidth(Ui.dp(getContext(), 3));
      paint.setStrokeCap(android.graphics.Paint.Cap.ROUND);
      float corner = Ui.dp(getContext(), 23);
      for (int x : new int[] {-1, 1})
        for (int y : new int[] {-1, 1}) {
          float px = x < 0 ? left : right, py = y < 0 ? top : bottom;
          android.graphics.Path path = new android.graphics.Path();
          path.moveTo(px - x * corner, py);
          path.lineTo(px, py);
          path.lineTo(px, py - y * corner);
          canvas.drawPath(path, paint);
        }
      paint.setColor(0x80b5f3ce);
      paint.setStrokeWidth(Ui.dp(getContext(), 1));
      canvas.drawLine(
          left + Ui.dp(getContext(), 12),
          (top + bottom) / 2,
          right - Ui.dp(getContext(), 12),
          (top + bottom) / 2,
          paint);
    }
  }

  void decode(Image image) {
    try {
      int w = image.getWidth(), h = image.getHeight();
      Image.Plane plane = image.getPlanes()[0];
      ByteBuffer buffer = plane.getBuffer();
      byte[] y = new byte[w * h];
      int stride = plane.getRowStride(), pixel = plane.getPixelStride();
      for (int row = 0; row < h; row++)
        for (int x = 0; x < w; x++) {
          int i = row * stride + x * pixel;
          if (i < buffer.limit()) y[row * w + x] = buffer.get(i);
        }
      Result result = read(y, w, h);
      if (result == null) {
        byte[] rotated = new byte[y.length];
        for (int row = 0; row < h; row++)
          for (int x = 0; x < w; x++) rotated[x * h + (h - row - 1)] = y[row * w + x];
        result = read(rotated, h, w);
      }
      if (result != null && !finishing) {
        finishing = true;
        String code = result.getText();
        runOnUiThread(
            () -> {
              setResult(RESULT_OK, new Intent().putExtra("code", code));
              finish();
            });
      }
    } catch (Exception ignored) {
    }
  }

  Result read(byte[] y, int w, int h) {
    PlanarYUVLuminanceSource source = new PlanarYUVLuminanceSource(y, w, h, 0, 0, w, h, false);
    try {
      return decoder.decodeWithState(new BinaryBitmap(new HybridBinarizer(source)));
    } catch (Exception ignored) {
      try {
        return decoder.decodeWithState(new BinaryBitmap(new HybridBinarizer(source.invert())));
      } catch (Exception nothing) {
        return null;
      }
    } finally {
      decoder.reset();
    }
  }

  @Override
  protected void onPause() {
    finishing = true;
    opening = false;
    if (session != null) {
      session.close();
      session = null;
    }
    if (camera != null) {
      camera.close();
      camera = null;
    }
    if (reader != null) {
      reader.close();
      reader = null;
    }
    if (worker != null) {
      worker.quitSafely();
      worker = null;
      handler = null;
    }
    super.onPause();
  }
}
