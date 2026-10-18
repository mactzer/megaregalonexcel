package io.github.mactzer.megacontrol;

import android.app.Activity;
import android.app.Instrumentation;
import android.content.ContentValues;
import android.content.Intent;
import android.content.IntentFilter;
import android.graphics.Bitmap;
import android.graphics.Paint;
import android.graphics.pdf.PdfDocument;
import android.net.Uri;
import android.os.Bundle;
import android.os.SystemClock;
import android.provider.MediaStore;
import android.view.View;
import android.view.ViewGroup;
import android.widget.TextView;
import com.google.zxing.BarcodeFormat;
import com.google.zxing.MultiFormatWriter;
import com.google.zxing.common.BitMatrix;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.util.Arrays;
import java.util.concurrent.atomic.AtomicReference;

/** Actual Android UI and crypto/provider integration with a fake, in-process backend. */
public final class NativeSmoke extends Instrumentation {
  @Override
  public void onCreate(Bundle args) {
    super.onCreate(args);
    start();
  }

  static void check(boolean v, String text) throws Exception {
    if (!v) throw new Exception(text);
  }

  boolean text(View v, String expected) {
    if (v instanceof TextView && ((TextView) v).getText().toString().contains(expected))
      return true;
    if (v instanceof ViewGroup)
      for (int i = 0; i < ((ViewGroup) v).getChildCount(); i++)
        if (text(((ViewGroup) v).getChildAt(i), expected)) return true;
    return false;
  }

  boolean web(View v) {
    if (v.getClass().getName().startsWith("android.webkit.")) return true;
    if (v instanceof ViewGroup)
      for (int i = 0; i < ((ViewGroup) v).getChildCount(); i++)
        if (web(((ViewGroup) v).getChildAt(i))) return true;
    return false;
  }

  void waitText(MainActivity a, String value) throws Exception {
    for (int i = 0; i < 150; i++) {
      AtomicReference<Boolean> found = new AtomicReference<>(false);
      runOnMainSync(() -> found.set(text(a.root, value)));
      if (found.get()) return;
      SystemClock.sleep(100);
    }
    throw new Exception("No apareció la vista nativa: " + value);
  }

  @Override
  public void onStart() {
    Bundle result = new Bundle();
    MainActivity a = null;
    Uri saved = null, photo = null;
    try {
      File fixture = new File(getTargetContext().getCacheDir(), "native-fixture.json"),
          report = new File(getTargetContext().getCacheDir(), "native-contract-result.json");
      try (InputStream in = getContext().getAssets().open("fixture.json");
          FileOutputStream out = new FileOutputStream(fixture)) {
        byte[] b = new byte[8192];
        int n;
        while ((n = in.read(b)) != -1) out.write(b, 0, n);
      }
      NativeContract.main(new String[] {fixture.getAbsolutePath(), report.getAbsolutePath()});
      a =
          (MainActivity)
              startActivitySync(
                  new Intent(Intent.ACTION_MAIN)
                      .setClassName(getTargetContext(), MainActivity.class.getName())
                      .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
      final MainActivity app = a;
      waitForIdleSync();
      check(!web(app.root), "La app no debe contener WebView");
      check(text(app.root, "Entra con tu cuenta"), "Inicio de sesión Android nativo");
      NativeContract.Fake backend = new NativeContract.Fake();
      NativeApi client =
          new NativeApi(
              "https://fixture.invalid",
              "public-fictional",
              NativeContract.fixture.getString("workspace"),
              null,
              backend);
      client.login("ficticio", NativeContract.fixture.getString("password").toCharArray());
      client.prepare(null);
      runOnMainSync(
          () -> {
            app.api.clear();
            app.api = client;
            app.shell();
            app.show(0);
            app.codeInput.setText("0012345678905");
            app.lookup();
          });
      waitText(app, "USD 8.99");
      check(!web(app.root), "Resultado usa TextView nativo");
      runOnMainSync(() -> app.show(2));
      waitText(app, "Consultas compartidas");
      runOnMainSync(() -> app.show(0));
      check(app.api.authenticated(), "Cambiar sección no cierra sesión");
      ContentValues values = new ContentValues();
      values.put(MediaStore.Downloads.DISPLAY_NAME, "MegaControl-ficticio.bin");
      values.put(MediaStore.Downloads.MIME_TYPE, "application/octet-stream");
      saved =
          getTargetContext()
              .getContentResolver()
              .insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
      check(saved != null, "Destino de descarga");
      byte[] bytes = new byte[180123];
      for (int i = 0; i < bytes.length; i++) bytes[i] = (byte) (i % 256);
      byte[] expected = bytes.clone();
      ActivityMonitor save =
          addMonitor(
              new IntentFilter(Intent.ACTION_CREATE_DOCUMENT),
              new ActivityResult(Activity.RESULT_OK, new Intent().setData(saved)),
              true);
      runOnMainSync(() -> app.save(bytes, "Prueba nativa 00123.bin", "application/octet-stream"));
      for (int i = 0; i < 100; i++) {
        byte[] actual;
        try (InputStream in = getTargetContext().getContentResolver().openInputStream(saved)) {
          java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
          byte[] block = new byte[8192];
          int n;
          while ((n = in.read(block)) != -1) out.write(block, 0, n);
          actual = out.toByteArray();
        }
        if (Arrays.equals(actual, expected)) break;
        SystemClock.sleep(100);
        if (i == 99) throw new Exception("La descarga no conservó todos los bytes");
      }
      removeMonitor(save);
      BitMatrix bars =
          new MultiFormatWriter().encode("0012345678905", BarcodeFormat.CODE_128, 1100, 350);
      Bitmap bitmap = Bitmap.createBitmap(1100, 350, Bitmap.Config.ARGB_8888);
      for (int y = 0; y < 350; y++)
        for (int x = 0; x < 1100; x++)
          bitmap.setPixel(x, y, bars.get(x, y) ? 0xff000000 : 0xffffffff);
      ContentValues imageValues = new ContentValues();
      imageValues.put(MediaStore.Images.Media.DISPLAY_NAME, "Etiqueta-ficticia.png");
      imageValues.put(MediaStore.Images.Media.MIME_TYPE, "image/png");
      photo =
          getTargetContext()
              .getContentResolver()
              .insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, imageValues);
      try (java.io.OutputStream out =
          getTargetContext().getContentResolver().openOutputStream(photo)) {
        bitmap.compress(Bitmap.CompressFormat.PNG, 100, out);
      }
      bitmap.recycle();
      final Uri chosen = photo;
      runOnMainSync(
          () -> {
            app.codeInput.setText("");
            app.scanResult.removeAllViews();
            app.onActivityResult(
                MainActivity.PHOTO, Activity.RESULT_OK, new Intent().setData(chosen));
          });
      waitText(app, "USD 8.99");
      check(
          app.codeInput.getText().toString().equals("0012345678905"),
          "Foto Code 128 conserva ceros iniciales");
      PdfDocument pdf = new PdfDocument();
      PdfDocument.Page page = pdf.startPage(new PdfDocument.PageInfo.Builder(400, 600, 1).create());
      page.getCanvas().drawText("PDF FICTICIO MEGACONTROL", 25, 50, new Paint());
      pdf.finishPage(page);
      java.io.ByteArrayOutputStream pdfBytes = new java.io.ByteArrayOutputStream();
      pdf.writeTo(pdfBytes);
      pdf.close();
      runOnMainSync(
          () -> {
            try {
              PdfView.open(app, pdfBytes.toByteArray());
            } catch (Exception e) {
              throw new RuntimeException(e);
            }
          });
      waitForIdleSync();
      sendKeyDownUpSync(android.view.KeyEvent.KEYCODE_BACK);
      check(Updater.compare("1.0.1", "1.0.0") > 0, "Semántica de actualización");
      runOnMainSync(() -> app.logout());
      waitText(app, "Entra con tu cuenta");
      check(!app.api.authenticated(), "Logout elimina claves y cuenta");
      fixture.delete();
      report.delete();
      result.putString(
          "stream",
          "OK: cifrado Android real, login y producto nativos, precio por fecha, navegación sin"
              + " logout, Code 128 en foto, PDF nativo y descarga byte a byte.\n");
      finish(Activity.RESULT_OK, result);
    } catch (Throwable e) {
      result.putString(
          "stream", "FALLO: " + e.toString() + "\n" + android.util.Log.getStackTraceString(e));
      finish(Activity.RESULT_CANCELED, result);
    } finally {
      if (saved != null) getTargetContext().getContentResolver().delete(saved, null, null);
      if (photo != null) getTargetContext().getContentResolver().delete(photo, null, null);
      if (a != null) {
        MainActivity close = a;
        runOnMainSync(() -> close.finish());
      }
    }
  }
}
