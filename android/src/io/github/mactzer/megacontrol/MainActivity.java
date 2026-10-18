package io.github.mactzer.megacontrol;

import android.app.Activity;
import android.app.AlertDialog;
import android.app.Dialog;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Color;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.InputType;
import android.view.Gravity;
import android.view.View;
import android.view.WindowInsets;
import android.view.inputmethod.EditorInfo;
import android.widget.ArrayAdapter;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.ScrollView;
import android.widget.Spinner;
import android.widget.TextView;
import android.widget.Toast;
import com.google.zxing.BinaryBitmap;
import com.google.zxing.MultiFormatReader;
import com.google.zxing.RGBLuminanceSource;
import com.google.zxing.common.HybridBinarizer;
import java.io.File;
import java.io.InputStream;
import java.io.OutputStream;
import java.math.BigDecimal;
import java.nio.file.Files;
import java.time.Instant;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONArray;
import org.json.JSONObject;

/** Native Android Views. There is deliberately no HTML or android.webkit dependency. */
public final class MainActivity extends Activity {
  static final int GREEN = Ui.BRAND, INK = Ui.INK, MUTED = Ui.MUTED, SOFT = Ui.BG;
  static final int SCAN = 10, PHOTO = 11, SAVE = 12;
  final Handler main = new Handler(Looper.getMainLooper());
  final ExecutorService io = Executors.newSingleThreadExecutor();
  NativeApi api;
  LinearLayout root, header, bottom, page, scanResult;
  FrameLayout content;
  TextView stateText;
  ProgressBar progress;
  EditText codeInput;
  Spinner searchMode;
  boolean destroyed, paused;
  int screen, viewEpoch, archiveOffset;
  String exactArchive = "";
  byte[] pendingDownload;
  JSONObject pendingMessage;
  String pendingMessageText = "";
  String chatDraft = "";
  EditText chatInput;
  final java.util.Set<Dialog> privateDialogs = new java.util.HashSet<>();
  Realtime realtime;
  boolean live;
  NativeApi.Result lastResult;
  long lastRecovery;
  final Runnable syncChanges = () -> refreshNative();
  final Runnable accessTick =
      new Runnable() {
        public void run() {
          if (destroyed || paused || !api.authenticated()) return;
          work(
              () -> {
                api.checkAccess(false);
                return true;
              },
              ok -> {});
          long interval = live ? 120000 : 30000;
          if (System.currentTimeMillis() - lastRecovery > interval) {
            lastRecovery = System.currentTimeMillis();
            refreshNative();
          }
          main.postDelayed(this, 15000);
        }
      };

  interface Work<T> {
    T run() throws Exception;
  }

  interface Done<T> {
    void accept(T result) throws Exception;
  }

  @Override
  public void onCreate(Bundle b) {
    super.onCreate(b);
    File[] oldPreviews =
        getCacheDir().listFiles((dir, name) -> name.startsWith("megacontrol-pdf-"));
    if (oldPreviews != null) for (File file : oldPreviews) file.delete();
    File cache = new File(getFilesDir(), "catalog-native.encrypted");
    api =
        new NativeApi(
            new NativeApi.Cache() {
              public String read() throws Exception {
                return new String(
                    Files.readAllBytes(cache.toPath()), java.nio.charset.StandardCharsets.UTF_8);
              }

              public void write(String text) throws Exception {
                File tmp = new File(getFilesDir(), "catalog-native.tmp");
                Files.write(tmp.toPath(), Crypto.utf8(text));
                if (!tmp.renameTo(cache))
                  throw new Exception("No se pudo conservar la caché cifrada.");
              }
            });
    root = new LinearLayout(this);
    root.setOrientation(LinearLayout.VERTICAL);
    root.setBackgroundColor(SOFT);
    if (Build.VERSION.SDK_INT >= 30) {
      getWindow().setDecorFitsSystemWindows(false);
      root.setOnApplyWindowInsetsListener(
          (v, insets) -> {
            android.graphics.Insets x =
                insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.ime());
            v.setPadding(x.left, x.top, x.right, x.bottom);
            return insets;
          });
    } else root.setFitsSystemWindows(true);
    setContentView(root);
    loginView();
  }

  int dp(int n) {
    return Math.round(n * getResources().getDisplayMetrics().density);
  }

  TextView text(String value, int size, int color) {
    TextView v = Ui.label(this, value, size, color);
    v.setPadding(0, dp(4), 0, dp(4));
    if (size >= 18) Ui.bold(v);
    v.setTextIsSelectable(true);
    return v;
  }

  LinearLayout column() {
    LinearLayout v = new LinearLayout(this);
    v.setOrientation(LinearLayout.VERTICAL);
    return v;
  }

  LinearLayout card(LinearLayout parent) {
    LinearLayout c = column();
    c.setPadding(dp(20), dp(18), dp(20), dp(18));
    GradientDrawable bg = new GradientDrawable();
    bg.setColor(Color.WHITE);
    bg.setCornerRadius(dp(24));
    bg.setStroke(dp(1), Ui.BORDER);
    c.setBackground(bg);
    c.setElevation(dp(1));
    LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(-1, -2);
    lp.setMargins(0, dp(10), 0, dp(6));
    parent.addView(c, lp);
    return c;
  }

  Button button(String title, Runnable action) {
    String icon =
        title.contains("PDF") || title.contains("Excel")
            ? "document"
            : title.contains("Historial") || title.contains("anteriores")
                ? "history"
                : title.contains("Reintentar") || title.contains("Actualizar")
                    ? "history"
                    : title.startsWith("Enviar")
                        ? "send"
                        : title.startsWith("Editar") ? "edit" : null;
    return Ui.action(this, title, icon, false, action);
  }

  EditText input(String hint, boolean password) {
    EditText e = new EditText(this);
    e.setHint(hint);
    e.setSingleLine(true);
    e.setTextSize(16);
    e.setTextColor(INK);
    e.setHintTextColor(MUTED);
    e.setInputType(
        password
            ? InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD
            : InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS);
    e.setPadding(dp(16), dp(14), dp(16), dp(14));
    e.setMinHeight(dp(54));
    e.setBackgroundTintList(null);
    android.graphics.drawable.StateListDrawable states =
        new android.graphics.drawable.StateListDrawable();
    GradientDrawable focused = Ui.shape(this, Color.WHITE, 14);
    focused.setStroke(dp(2), GREEN);
    GradientDrawable normal = Ui.shape(this, 0xfff8faf8, 14);
    normal.setStroke(dp(1), Ui.BORDER);
    states.addState(new int[] {android.R.attr.state_focused}, focused);
    states.addState(new int[] {}, normal);
    e.setBackground(states);
    LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(-1, -2);
    lp.setMargins(0, dp(5), 0, dp(8));
    e.setLayoutParams(lp);
    return e;
  }

  void pageTitle(String eyebrow, String title, String subtitle) {
    TextView kicker = text(eyebrow.toUpperCase(new Locale("es")), 11, GREEN);
    kicker.setLetterSpacing(.12f);
    Ui.bold(kicker);
    page.addView(kicker);
    page.addView(text(title, 28, INK));
    if (!subtitle.isEmpty()) page.addView(text(subtitle, 14, MUTED));
    Ui.space(page, 8);
  }

  void notify(String s) {
    if (!destroyed) Toast.makeText(this, s, Toast.LENGTH_LONG).show();
  }

  void error(Exception e) {
    if (destroyed) return;
    String msg =
        e instanceof java.io.IOException
            ? "No se pudo conectar. Revisa Internet y vuelve a intentarlo."
            : e.getMessage();
    new AlertDialog.Builder(this)
        .setTitle("MegaControl")
        .setMessage(msg == null ? "No se pudo completar la operación." : msg)
        .setPositiveButton("Aceptar", null)
        .show();
  }

  void status(String s) {
    if (stateText != null) stateText.setText(s);
  }

  <T> void work(Work<T> job, Done<T> done) {
    work(job, done, () -> {});
  }

  <T> void work(Work<T> job, Done<T> done, Runnable finished) {
    int view = viewEpoch, epoch = api.epoch;
    if (progress != null) progress.setVisibility(View.VISIBLE);
    io.execute(
        () -> {
          try {
            if (epoch != api.epoch) throw new Exception("La sesión cambió.");
            T result = job.run();
            main.post(
                () -> {
                  if (destroyed) return;
                  if (progress != null) progress.setVisibility(View.GONE);
                  try {
                    if (epoch != api.epoch || view != viewEpoch) return;
                    done.accept(result);
                  } catch (Exception e) {
                    error(e);
                  } finally {
                    finished.run();
                  }
                });
          } catch (Exception e) {
            main.post(
                () -> {
                  if (destroyed) return;
                  if (progress != null) progress.setVisibility(View.GONE);
                  try {
                    if (!api.authenticated() && screen != -1) {
                      stopLive();
                      loginView();
                      error(e);
                    } else if (view == viewEpoch) error(e);
                  } finally {
                    finished.run();
                  }
                });
          }
        });
  }

  void loginView() {
    closePrivateDialogs();
    if (!api.authenticated()) {
      lastResult = null;
      chatDraft = "";
      chatInput = null;
      pendingMessage = null;
      pendingMessageText = "";
    }
    viewEpoch++;
    screen = -1;
    root.removeAllViews();
    LinearLayout c = column();
    c.setPadding(dp(24), dp(34), dp(24), dp(26));
    ScrollView scroll = new ScrollView(this);
    scroll.setFillViewport(true);
    scroll.addView(c);
    root.addView(scroll, new LinearLayout.LayoutParams(-1, -1));
    LinearLayout brand = column();
    brand.setPadding(dp(24), dp(26), dp(24), dp(24));
    GradientDrawable brandBackground =
        new GradientDrawable(
            GradientDrawable.Orientation.TL_BR, new int[] {0xff16735d, 0xff103f35});
    brandBackground.setCornerRadius(dp(28));
    brand.setBackground(brandBackground);
    c.addView(brand);
    ImageView icon = new ImageView(this);
    icon.setImageResource(R.drawable.megacontrol_logo);
    icon.setBackground(Ui.shape(this, Color.WHITE, 17));
    icon.setPadding(dp(8), dp(8), dp(8), dp(8));
    LinearLayout.LayoutParams logo = new LinearLayout.LayoutParams(dp(56), dp(56));
    brand.addView(icon, logo);
    Ui.space(brand, 16);
    brand.addView(text("MegaControl", 30, Color.WHITE));
    brand.addView(text("Tu equipo. Tus salidas.\nTodo bajo control.", 16, 0xffc9e6d7));
    Ui.space(c, 12);
    LinearLayout box = card(c);
    box.addView(text("Entra con tu cuenta", 22, INK));
    box.addView(text("Bienvenido de nuevo. Usa tu cuenta habitual.", 14, MUTED));
    Ui.space(box, 12);
    EditText user = input("Usuario", false), password = input("Contraseña", true);
    user.setAutofillHints(View.AUTOFILL_HINT_USERNAME);
    password.setAutofillHints(View.AUTOFILL_HINT_PASSWORD);
    box.addView(text("Usuario", 12, MUTED));
    box.addView(user);
    box.addView(text("Contraseña", 12, MUTED));
    box.addView(password);
    progress = new ProgressBar(this);
    progress.setVisibility(View.GONE);
    box.addView(progress);
    stateText = text("", 12, MUTED);
    box.addView(stateText);
    Button sign = button("Iniciar sesión", () -> {});
    Ui.styleButton(sign, true, "arrow");
    sign.setOnClickListener(
        v -> {
          if (user.getText().toString().trim().isEmpty() || password.getText().length() == 0) {
            notify("Escribe tu usuario y contraseña.");
            return;
          }
          sign.setEnabled(false);
          char[] secret = password.getText().toString().toCharArray();
          password.setText("");
          String name = user.getText().toString();
          int attempt = viewEpoch;
          progress.setVisibility(View.VISIBLE);
          status("Verificando acceso cifrado…");
          io.execute(
              () -> {
                try {
                  api.login(name, secret);
                  api.prepare(
                      msg ->
                          main.post(
                              () -> {
                                if (viewEpoch == attempt) status(msg);
                              }));
                  main.post(
                      () -> {
                        if (!destroyed && viewEpoch == attempt) {
                          shell();
                          show(0);
                          startLive();
                        }
                      });
                } catch (Exception e) {
                  Arrays.fill(secret, '\0');
                  main.post(
                      () -> {
                        if (!destroyed && attempt == viewEpoch) {
                          sign.setEnabled(true);
                          progress.setVisibility(View.GONE);
                          status("Vuelve a intentar el acceso.");
                          error(e);
                        }
                      });
                }
              });
        });
    box.addView(sign);
    Ui.space(c, 18);
    TextView secure = text("Acceso seguro · Información cifrada", 12, MUTED);
    secure.setGravity(Gravity.CENTER);
    secure.setCompoundDrawablesRelativeWithIntrinsicBounds(
        new Ui.Icon(this, "shield", GREEN, 17), null, null, null);
    secure.setCompoundDrawablePadding(dp(8));
    c.addView(secure);
  }

  void shell() {
    root.removeAllViews();
    header = new LinearLayout(this);
    header.setGravity(Gravity.CENTER_VERTICAL);
    header.setPadding(dp(20), dp(12), dp(14), dp(10));
    header.setBackgroundColor(Color.WHITE);
    ImageView logo = new ImageView(this);
    logo.setImageResource(R.drawable.megacontrol_logo);
    LinearLayout.LayoutParams logoLp = new LinearLayout.LayoutParams(dp(33), dp(33));
    logoLp.rightMargin = dp(10);
    header.addView(logo, logoLp);
    LinearLayout identity = column();
    identity.addView(text("MegaControl", 20, INK));
    identity.addView(Ui.label(this, "Control de salidas", 11, MUTED));
    header.addView(identity, new LinearLayout.LayoutParams(0, -2, 1));
    TextView avatar =
        Ui.label(this, api.username.substring(0, 1).toUpperCase(Locale.ROOT), 14, GREEN);
    Ui.bold(avatar);
    avatar.setGravity(Gravity.CENTER);
    avatar.setBackground(Ui.shape(this, Ui.PALE, 24));
    LinearLayout.LayoutParams avatarLp = new LinearLayout.LayoutParams(dp(34), dp(34));
    avatarLp.rightMargin = dp(6);
    header.addView(avatar, avatarLp);
    header.addView(
        Ui.iconButton(
            this,
            "more",
            "Opciones de cuenta",
            INK,
            Color.WHITE,
            () ->
                new AlertDialog.Builder(this)
                    .setTitle(
                        "@"
                            + api.username
                            + " · "
                            + (api.role.equals("admin") ? "Administrador" : "Usuario"))
                    .setItems(
                        new String[] {
                          "Actualizar catálogo",
                          "Buscar actualización de la app",
                          "Bibliotecas y licencias",
                          "Cerrar sesión"
                        },
                        (d, n) -> {
                          if (n == 0)
                            work(
                                () -> api.prepare(null),
                                s -> {
                                  status(s);
                                  notify("Catálogo comprobado.");
                                });
                          else if (n == 1) checkUpdate();
                          else if (n == 2) {
                            try (java.util.Scanner notice =
                                new java.util.Scanner(
                                    getResources().openRawResource(R.raw.third_party_notices),
                                    "UTF-8")) {
                              showDialog(
                                  "Bibliotecas y licencias",
                                  text(notice.useDelimiter("\\A").next(), 12, MUTED));
                            }
                          } else logout();
                        })
                    .show()));
    root.addView(header);
    stateText = text("@" + api.username, 11, MUTED);
    stateText.setPadding(dp(20), dp(6), dp(20), dp(6));
    root.addView(stateText);
    progress = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
    progress.setIndeterminate(true);
    progress.setVisibility(View.GONE);
    root.addView(progress, new LinearLayout.LayoutParams(-1, dp(3)));
    content = new FrameLayout(this);
    root.addView(content, new LinearLayout.LayoutParams(-1, 0, 1));
    bottom = new LinearLayout(this);
    bottom.setPadding(dp(10), dp(3), dp(10), dp(4));
    bottom.setBackgroundColor(Color.WHITE);
    String[] labels = {"Escanear", "Archivo", "Consultas", "Chat"};
    String[] icons = {"scan", "archive", "history", "chat"};
    for (int i = 0; i < labels.length; i++) {
      final int n = i;
      bottom.addView(
          Ui.nav(this, labels[i], icons[i], () -> show(n)),
          new LinearLayout.LayoutParams(0, dp(70), 1));
    }
    root.addView(bottom);
  }

  void show(int target) {
    if (screen == 3 && chatInput != null) chatDraft = chatInput.getText().toString();
    chatInput = null;
    viewEpoch++;
    screen = target;
    content.removeAllViews();
    page = column();
    page.setPadding(dp(20), dp(18), dp(20), dp(26));
    ScrollView scroll = new ScrollView(this);
    scroll.setFillViewport(true);
    scroll.addView(page);
    content.addView(scroll);
    String[] icons = {"scan", "archive", "history", "chat"};
    for (int i = 0; i < bottom.getChildCount(); i++)
      Ui.selectNav((LinearLayout) bottom.getChildAt(i), i == target, icons[i]);
    status("@" + api.username + " · " + (api.role.equals("admin") ? "Administrador" : "Usuario"));
    if (target == 0) scannerView();
    else if (target == 1) archiveView();
    else if (target == 2) queriesView();
    else chatView();
  }

  void scannerView() {
    pageTitle(
        "Escáner de productos",
        "Consulta precios",
        "Encuentra el precio y las salidas de cada producto.");
    LinearLayout hero = column();
    hero.setPadding(dp(22), dp(22), dp(22), dp(22));
    GradientDrawable gradient =
        new GradientDrawable(
            GradientDrawable.Orientation.TL_BR, new int[] {0xff14745c, 0xff103f35});
    gradient.setCornerRadius(dp(26));
    hero.setBackground(
        new android.graphics.drawable.RippleDrawable(
            android.content.res.ColorStateList.valueOf(0x28ffffff), gradient, null));
    LinearLayout heroTop = new LinearLayout(this);
    heroTop.setGravity(Gravity.CENTER_VERTICAL);
    ImageView scanIcon = Ui.image(this, "scan", Color.WHITE, 32);
    scanIcon.setPadding(dp(11), dp(11), dp(11), dp(11));
    scanIcon.setBackground(Ui.shape(this, 0x22ffffff, 17));
    heroTop.addView(scanIcon, new LinearLayout.LayoutParams(dp(56), dp(56)));
    TextView ready = Ui.badge(this, "CÓDIGO DE BARRAS", 0xffdaf0e2, 0x20ffffff);
    LinearLayout.LayoutParams readyLp = new LinearLayout.LayoutParams(-2, -2);
    readyLp.leftMargin = dp(14);
    heroTop.addView(ready, readyLp);
    hero.addView(heroTop);
    Ui.space(hero, 16);
    hero.addView(text("Escanear producto", 24, Color.WHITE));
    hero.addView(text("Apunta al código de barras para consultar.", 13, 0xffc5e5d5));
    hero.setContentDescription("Escanear producto con la cámara");
    hero.setFocusable(true);
    hero.setOnClickListener(
        v -> startActivityForResult(new Intent(this, ScannerActivity.class), SCAN));
    page.addView(hero, new LinearLayout.LayoutParams(-1, -2));
    page.addView(
        Ui.action(
            this,
            "Leer etiqueta desde una foto",
            "photo",
            false,
            () ->
                startActivityForResult(
                    new Intent(Intent.ACTION_OPEN_DOCUMENT)
                        .addCategory(Intent.CATEGORY_OPENABLE)
                        .setType("image/*"),
                    PHOTO)));
    LinearLayout box = card(page);
    box.addView(text("Buscar sin cámara", 18, INK));
    box.addView(text("Código, referencia o nombre del producto", 12, MUTED));
    searchMode = new Spinner(this);
    searchMode.setAdapter(
        new ArrayAdapter<>(
            this,
            android.R.layout.simple_spinner_dropdown_item,
            new String[] {"Código de barras", "Referencia", "Nombre del producto"}));
    searchMode.setBackgroundTintList(android.content.res.ColorStateList.valueOf(GREEN));
    box.addView(searchMode, new LinearLayout.LayoutParams(-1, dp(46)));
    codeInput = input("Ej. 7501022104217", false);
    codeInput.setImeOptions(EditorInfo.IME_ACTION_SEARCH);
    codeInput.setOnEditorActionListener(
        (v, id, event) -> {
          if (id == EditorInfo.IME_ACTION_SEARCH) {
            lookup();
            return true;
          }
          return false;
        });
    searchMode.setOnItemSelectedListener(
        new android.widget.AdapterView.OnItemSelectedListener() {
          public void onNothingSelected(android.widget.AdapterView<?> p) {}

          public void onItemSelected(
              android.widget.AdapterView<?> p, View v, int position, long id) {
            codeInput.setHint(
                position == 0
                    ? "Ej. 7501022104217"
                    : position == 1 ? "Ej. DM141-5" : "Nombre o parte de la referencia");
          }
        });
    LinearLayout searchRow = new LinearLayout(this);
    searchRow.setGravity(Gravity.CENTER_VERTICAL);
    LinearLayout.LayoutParams inputLp = new LinearLayout.LayoutParams(0, dp(54), 1);
    inputLp.rightMargin = dp(8);
    searchRow.addView(codeInput, inputLp);
    Button search =
        Ui.iconButton(this, "search", "Buscar producto", Color.WHITE, GREEN, () -> lookup());
    searchRow.addView(search, new LinearLayout.LayoutParams(dp(54), dp(54)));
    Ui.space(box, 6);
    box.addView(searchRow);
    Ui.space(box, 10);
    box.addView(
        text("Los códigos se conservan completos, incluidos los ceros iniciales.", 11, MUTED));
    TextView index = text(api.summary(), 11, MUTED);
    index.setGravity(Gravity.CENTER);
    page.addView(index);
    scanResult = column();
    page.addView(scanResult);
  }

  void lookup() {
    String raw = codeInput.getText().toString().trim();
    if (raw.isEmpty()) {
      notify("Escribe el código, nombre o referencia.");
      return;
    }
    int mode = searchMode.getSelectedItemPosition();
    status("Consultando precio e índice…");
    if (mode == 2) {
      work(
          () -> api.search(raw),
          matches -> {
            scanResult.removeAllViews();
            scanResult.addView(text(matches.size() + " coincidencias", 20, INK));
            for (NativeApi.Match m : matches) {
              String code = NativeApi.text(m.product, "codigo"),
                  ref = NativeApi.text(m.product, "ref");
              LinearLayout c = card(scanResult);
              c.addView(text(NativeApi.text(m.product, "descripcion"), 18, INK));
              c.addView(text(code + " · " + ref, 14, MUTED));
              c.addView(
                  button(
                      "Consultar",
                      () -> {
                        codeInput.setText(code.isEmpty() ? ref : code);
                        searchMode.setSelection(code.isEmpty() ? 1 : 0);
                        lookup();
                      }));
            }
          });
    } else
      work(
          () -> api.lookup(raw, mode == 1),
          r -> {
            renderResult(r);
            recordQuery(r);
          });
  }

  void renderResult(NativeApi.Result r) throws Exception {
    lastResult = r;
    scanResult.removeAllViews();
    LinearLayout c = card(scanResult);
    boolean found = r.match != null && !r.ambiguous;
    c.addView(
        Ui.badge(
            this,
            found
                ? "Producto encontrado"
                : r.ambiguous
                    ? "Referencia ambigua"
                    : r.incomplete ? "Consulta incompleta" : "Sin coincidencia en el índice",
            found ? GREEN : 0xff8a5b14,
            found ? Ui.PALE : 0xfffff2d9));
    if (r.incomplete)
      c.addView(
          text(
              "El índice está incompleto. Puede haber documentos más recientes pendientes de"
                  + " preparar.",
              14,
              0xff8a5b14));
    if (!found) {
      c.addView(text(r.query, 24, INK));
      c.addView(
          text(
              r.ambiguous
                  ? "Esta referencia pertenece a varios códigos. Consulta el código de la etiqueta."
                  : r.incomplete
                      ? "No se puede confirmar la ausencia del producto con el índice incompleto."
                      : "Este código no aparece en los documentos preparados. No confirma que falte"
                          + " en el inventario de la empresa.",
              16,
              MUTED));
      return;
    }
    JSONObject product = r.match.product, doc = r.match.doc;
    Ui.space(c, 12);
    c.addView(text(NativeApi.text(product, "descripcion"), 21, INK));
    Double original = NativeApi.value(product, "pventa");
    Long cents =
        r.override != null
            ? r.override.getLong("cents")
            : original == null || r.conflicting ? null : Math.round(original * 100);
    LinearLayout pricePanel = column();
    pricePanel.setPadding(dp(16), dp(12), dp(16), dp(12));
    pricePanel.setBackground(Ui.shape(this, 0xffeff7f1, 18));
    LinearLayout.LayoutParams priceLp = new LinearLayout.LayoutParams(-1, -2);
    priceLp.setMargins(0, dp(12), 0, dp(14));
    c.addView(pricePanel, priceLp);
    pricePanel.addView(
        text(
            cents == null
                ? "Precio de venta no disponible"
                : String.format(Locale.US, "USD %.2f", cents / 100.0),
            36,
            GREEN));
    pricePanel.addView(
        text(
            r.override != null
                ? "Precio modificado por un administrador · "
                    + when(r.override.getString("updated_at"))
                : "registered".equals(doc.optString("kind"))
                    ? "Precio del registro administrativo"
                    : "Precio de la última factura encontrada",
            12,
            MUTED));
    if (r.conflicting && r.override == null)
      c.addView(
          text(
              "La misma factura contiene precios distintos. Revisa el documento.", 14, 0xff8a5b14));
    detail(c, "Código de barras", NativeApi.text(product, "codigo"));
    detail(c, "Referencia", NativeApi.text(product, "ref"));
    detail(c, "Empaque", NativeApi.text(product, "empaque"));
    detail(c, "Salida de origen", NativeApi.text(doc, "salida"));
    detail(c, "Fecha de factura", date(NativeApi.text(doc, "invoiceDate")));
    detail(c, "Precio comprobado", when(Instant.ofEpochMilli(r.checkedAt).toString()));
    if (api.role.equals("admin"))
      c.addView(button("Editar precio", () -> editPrice(r, cents, null)));
    c.addView(button("Historial de precios", () -> priceHistory(r, 0)));
    if (!r.history.isEmpty()) {
      c.addView(text("Salidas", 20, INK));
      for (NativeApi.Match m : r.history) {
        Double price = NativeApi.value(m.product, "pventa");
        c.addView(
            text(
                "Salida "
                    + NativeApi.text(m.doc, "salida")
                    + " · "
                    + (price == null ? "Sin precio" : String.format(Locale.US, "USD %.2f", price))
                    + " · "
                    + date(NativeApi.text(m.doc, "invoiceDate")),
                14,
                MUTED));
      }
    }
    c.addView(button("Compartir producto en el chat", () -> share(r, cents)));
    status("Consulta comprobada · " + api.summary());
  }

  void detail(LinearLayout p, String label, String value) {
    LinearLayout row = new LinearLayout(this);
    row.setGravity(Gravity.CENTER_VERTICAL);
    row.setPadding(0, dp(9), 0, dp(9));
    TextView key = text(label, 12, MUTED),
        data = text(value.isEmpty() ? "No disponible" : value, 14, INK);
    data.setGravity(Gravity.END);
    if (label.contains("Código") || label.equals("Referencia"))
      data.setTypeface(
          android.graphics.Typeface.create("monospace", android.graphics.Typeface.NORMAL));
    row.addView(key, new LinearLayout.LayoutParams(0, -2, 1));
    row.addView(data, new LinearLayout.LayoutParams(0, -2, 1.4f));
    p.addView(row);
    View divider = new View(this);
    divider.setBackgroundColor(Ui.BORDER);
    p.addView(divider, new LinearLayout.LayoutParams(-1, dp(1)));
  }

  void editPrice(NativeApi.Result result, Long initial, Long restoredVersion) {
    LinearLayout form = column();
    form.setPadding(dp(20), dp(6), dp(20), dp(6));
    EditText price = input("Nuevo precio de venta", false),
        reason = input("Motivo del cambio", false);
    price.setInputType(InputType.TYPE_CLASS_NUMBER | InputType.TYPE_NUMBER_FLAG_DECIMAL);
    if (initial != null) price.setText(String.format(Locale.US, "%.2f", initial / 100.0));
    form.addView(price);
    form.addView(reason);
    AlertDialog dialog =
        new AlertDialog.Builder(this)
            .setTitle(
                restoredVersion == null
                    ? "Editar precio"
                    : "Restaurar precio de versión " + restoredVersion)
            .setView(form)
            .setNegativeButton("Cancelar", null)
            .setPositiveButton("Guardar", null)
            .create();
    dialog.setOnShowListener(
        v ->
            dialog
                .getButton(-1)
                .setOnClickListener(
                    v2 -> {
                      try {
                        String raw = price.getText().toString().trim().replace(',', '.');
                        if (!raw.matches("[0-9]{1,7}(\\.[0-9]{1,2})?"))
                          throw new Exception("Escribe un precio válido, por ejemplo 7.99.");
                        long cents = new BigDecimal(raw).movePointRight(2).longValueExact();
                        String note = reason.getText().toString().trim();
                        if (note.isEmpty()) throw new Exception("Escribe el motivo del cambio.");
                        long expected =
                            result.override == null ? 0 : result.override.getLong("version");
                        Long previous =
                            result.override != null
                                ? result.override.getLong("cents")
                                : NativeApi.value(result.match.product, "pventa") == null
                                    ? null
                                    : Math.round(
                                        NativeApi.value(result.match.product, "pventa") * 100);
                        dialog.getButton(-1).setEnabled(false);
                        work(
                            () -> {
                              api.setPrice(
                                  result.lookupCode,
                                  cents,
                                  expected,
                                  note,
                                  previous,
                                  restoredVersion);
                              return api.lookup(result.query, result.byReference);
                            },
                            r -> {
                              dialog.dismiss();
                              renderResult(r);
                              notify("Precio guardado y compartido con el equipo.");
                            },
                            () -> {
                              if (dialog.isShowing()) dialog.getButton(-1).setEnabled(true);
                            });
                      } catch (Exception e) {
                        error(e);
                      }
                    }));
    dialog.show();
    track(dialog);
  }

  void priceHistory(NativeApi.Result r, int offset) {
    work(
        () -> {
          Map<String, String> names = api.authors();
          JSONArray rows = api.priceHistory(r.lookupCode, offset);
          return NativeApi.obj("rows", rows, "names", new JSONObject(names));
        },
        response -> {
          LinearLayout items = column();
          items.setPadding(dp(16), dp(10), dp(16), dp(10));
          JSONArray rows = response.getJSONArray("rows");
          JSONObject names = response.getJSONObject("names");
          for (int i = 0; i < rows.length(); i++) {
            JSONObject p = rows.getJSONObject(i);
            LinearLayout c = card(items);
            c.addView(
                text(
                    String.format(Locale.US, "USD %.2f", p.getLong("cents") / 100.0)
                        + " · Versión "
                        + p.getLong("version"),
                    20,
                    GREEN));
            c.addView(
                text(
                    "@"
                        + names.optString(p.getString("updated_by"), "Equipo")
                        + " · "
                        + when(p.getString("updated_at")),
                    13,
                    MUTED));
            c.addView(text(p.optString("reason", "Sin motivo registrado"), 15, INK));
            if (api.role.equals("admin")) {
              long cents = p.getLong("cents"), version = p.getLong("version");
              c.addView(button("Restaurar este precio", () -> editPrice(r, cents, version)));
            }
          }
          if (rows.length() == 0)
            items.addView(text("No hay cambios administrativos registrados.", 16, MUTED));
          if (rows.length() == 20)
            items.addView(button("Ver cambios anteriores", () -> priceHistory(r, offset + 20)));
          showDialog("Historial de precios", items);
        });
  }

  void recordQuery(NativeApi.Result r) {
    io.execute(
        () -> {
          try {
            JSONObject ticket = api.queryTicket(r);
            File pending =
                new File(getFilesDir(), "query-pending-" + ticket.getString("id") + ".json");
            Files.write(pending.toPath(), Crypto.utf8(ticket.toString()));
            api.saveQuery(ticket);
            pending.delete();
          } catch (Exception e) {
            main.post(
                () -> {
                  if (!destroyed && api.authenticated())
                    status("Consulta pendiente de compartir. Reintenta desde Consultas.");
                });
          }
        });
  }

  void retryQueries() {
    work(
        () -> {
          File[] files =
              getFilesDir()
                  .listFiles(
                      (d, name) -> name.startsWith("query-pending-") && name.endsWith(".json"));
          int count = 0;
          if (files != null)
            for (File f : files) {
              JSONObject ticket =
                  new JSONObject(
                      new String(
                          Files.readAllBytes(f.toPath()), java.nio.charset.StandardCharsets.UTF_8));
              if (api.userId.equals(ticket.optString("owner"))) {
                api.saveQuery(ticket);
                f.delete();
                count++;
              }
            }
          return count;
        },
        n -> {
          notify(n + " consultas confirmadas.");
          show(2);
        });
  }

  void queriesView() {
    pageTitle(
        "Actividad del equipo",
        "Consultas compartidas",
        "Las búsquedas del equipo, en un solo lugar.");
    page.addView(button("Actualizar", () -> show(2)));
    page.addView(button("Reintentar consultas pendientes", () -> retryQueries()));
    work(
        () -> NativeApi.obj("rows", api.queries(), "names", new JSONObject(api.authors())),
        response -> {
          JSONArray rows = response.getJSONArray("rows");
          JSONObject names = response.getJSONObject("names");
          for (int i = 0; i < rows.length(); i++) {
            JSONObject q = rows.getJSONObject(i);
            LinearLayout c = card(page);
            c.addView(text(q.getString("code"), 20, INK));
            c.addView(text(q.getString("label"), 16, GREEN));
            if (!q.optString("description").isEmpty())
              c.addView(text(q.getString("description"), 16, INK));
            c.addView(
                text(
                    "@"
                        + names.optString(q.getString("created_by"), "Equipo")
                        + " · "
                        + when(q.getString("created_at")),
                    13,
                    MUTED));
          }
          if (rows.length() == 0)
            page.addView(text("Aún no hay consultas compartidas.", 16, MUTED));
        });
  }

  void archiveView() {
    pageTitle(
        "Tus documentos", "Archivo de salidas", "Consulta documentos, productos y versiones.");
    EditText number = input("Número exacto de salida", false);
    number.setInputType(InputType.TYPE_CLASS_NUMBER);
    number.setText(exactArchive);
    page.addView(number);
    page.addView(
        button(
            "Buscar",
            () -> {
              exactArchive = number.getText().toString().trim();
              archiveOffset = 0;
              show(1);
            }));
    work(
        () -> api.archive(archiveOffset, exactArchive),
        rows -> {
          for (int i = 0; i < rows.length(); i++) {
            JSONObject m = rows.getJSONObject(i), record = m.getJSONObject("record");
            LinearLayout c = card(page);
            LinearLayout titleRow = new LinearLayout(this);
            titleRow.setGravity(Gravity.CENTER_VERTICAL);
            ImageView docIcon = Ui.image(this, "archive", GREEN, 21);
            docIcon.setPadding(dp(10), dp(10), dp(10), dp(10));
            docIcon.setBackground(Ui.shape(this, Ui.PALE, 13));
            titleRow.addView(docIcon, new LinearLayout.LayoutParams(dp(42), dp(42)));
            TextView docTitle = text("Salida " + m.getString("salida_numero"), 20, INK);
            LinearLayout.LayoutParams titleLp = new LinearLayout.LayoutParams(0, -2, 1);
            titleLp.leftMargin = dp(12);
            titleRow.addView(docTitle, titleLp);
            c.addView(titleRow);
            Ui.space(c, 10);
            c.addView(
                text(
                    "@" + m.getString("username") + " · " + when(record.getString("created_at")),
                    14,
                    MUTED));
            c.addView(
                text(
                    m.getInt("row_count")
                        + " productos · "
                        + m.getDouble("total_units")
                        + " unidades",
                    15,
                    MUTED));
            if (record.optInt("salida_version") > 0)
              c.addView(
                  text("Versión " + record.getInt("salida_version") + " · Actual", 13, GREEN));
            c.addView(button("Abrir detalle", () -> archiveDetail(m)));
          }
          if (rows.length() == 0) page.addView(text("No se encontraron salidas.", 16, MUTED));
          LinearLayout pages = new LinearLayout(this);
          Button previous =
              button(
                  "Anterior",
                  () -> {
                    archiveOffset = Math.max(0, archiveOffset - 25);
                    show(1);
                  });
          previous.setEnabled(archiveOffset > 0);
          pages.addView(previous, new LinearLayout.LayoutParams(0, -2, 1));
          Button next =
              button(
                  "Siguiente",
                  () -> {
                    archiveOffset += 25;
                    show(1);
                  });
          next.setEnabled(rows.length() == 25);
          pages.addView(next, new LinearLayout.LayoutParams(0, -2, 1));
          page.addView(pages);
        });
  }

  void archiveDetail(JSONObject m) {
    try {
      JSONObject record = m.getJSONObject("record");
      LinearLayout box = column();
      box.setPadding(dp(18), dp(8), dp(18), dp(14));
      detail(box, "Responsable", "@" + m.getString("username"));
      detail(box, "Fecha de registro", when(record.getString("created_at")));
      JSONObject doc = api.catalog.get(record.getString("id"));
      detail(box, "Fecha de factura", doc == null ? "" : date(NativeApi.text(doc, "invoiceDate")));
      detail(box, "Productos", String.valueOf(m.getInt("row_count")));
      detail(box, "Unidades", String.valueOf(m.getDouble("total_units")));
      box.addView(
          button(
              "Ver PDF",
              () ->
                  work(
                      () -> api.document(record, "pdf"),
                      bytes -> track(PdfView.open(this, bytes)))));
      box.addView(
          button(
              "Guardar PDF",
              () ->
                  work(
                      () -> api.document(record, "pdf"),
                      bytes -> save(bytes, m.getString("pdf_name"), "application/pdf"))));
      box.addView(
          button(
              "Guardar Excel original",
              () ->
                  work(
                      () -> api.document(record, "excel"),
                      bytes ->
                          save(
                              bytes,
                              m.getString("excel_name"),
                              "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"))));
      if (doc != null) {
        box.addView(text("Productos de esta salida", 20, INK));
        JSONArray products = doc.getJSONArray("products");
        for (int i = 0; i < products.length(); i++) {
          JSONObject p = products.getJSONObject(i);
          box.addView(
              text(
                  NativeApi.text(p, "codigo") + " · " + NativeApi.text(p, "descripcion"), 14, INK));
        }
      }
      box.addView(button("Historial de versiones", () -> versions(record)));
      showDialog("Salida " + m.getString("salida_numero"), box);
    } catch (Exception e) {
      error(e);
    }
  }

  void versions(JSONObject record) {
    String tag = record.optString("salida_identity_tag");
    if (!tag.matches("[a-f0-9]{64}")) {
      notify("Esta salida no tiene versiones vinculadas.");
      return;
    }
    work(
        () ->
            api.list(
                "mega_audit_records",
                "salida_identity_tag=eq." + tag + "&select=*&order=salida_version.desc&limit=100"),
        rows -> {
          LinearLayout c = column();
          c.setPadding(dp(16), dp(8), dp(16), dp(8));
          for (int i = 0; i < rows.length(); i++) {
            JSONObject row = rows.getJSONObject(i), m = api.metadata(row);
            LinearLayout item = card(c);
            item.addView(
                text(
                    "Versión "
                        + row.optInt("salida_version")
                        + (row.isNull("duplicate_of") ? " · Actual" : " · Anterior"),
                    20,
                    GREEN));
            item.addView(
                text(
                    "@" + m.getString("username") + " · " + when(row.getString("created_at")),
                    14,
                    MUTED));
            item.addView(
                text(
                    m.getInt("row_count")
                        + " productos · "
                        + m.getDouble("total_units")
                        + " unidades",
                    15,
                    INK));
            item.addView(
                button(
                    "Guardar PDF de esta versión",
                    () ->
                        work(
                            () -> api.document(row, "pdf"),
                            data -> save(data, m.getString("pdf_name"), "application/pdf"))));
            item.addView(
                button(
                    "Guardar Excel de esta versión",
                    () ->
                        work(
                            () -> api.document(row, "excel"),
                            data ->
                                save(
                                    data,
                                    m.getString("excel_name"),
                                    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"))));
          }
          showDialog("Historial de versiones", c);
        });
  }

  void chatView() {
    content.removeAllViews();
    LinearLayout chatRoot = column();
    content.addView(chatRoot, new FrameLayout.LayoutParams(-1, -1));
    LinearLayout toolbar = new LinearLayout(this);
    toolbar.setPadding(dp(20), dp(14), dp(12), dp(14));
    toolbar.setGravity(Gravity.CENTER_VERTICAL);
    LinearLayout heading = column();
    heading.addView(text("Chat del equipo", 24, INK));
    heading.addView(text("Mensajes compartidos · Cifrado", 12, MUTED));
    toolbar.addView(heading, new LinearLayout.LayoutParams(0, -2, 1));
    chatRoot.addView(toolbar);
    LinearLayout messages = column();
    messages.setPadding(dp(18), dp(4), dp(18), dp(14));
    ScrollView conversation = new ScrollView(this);
    conversation.setFillViewport(true);
    conversation.addView(messages);
    chatRoot.addView(conversation, new LinearLayout.LayoutParams(-1, 0, 1));
    LinearLayout composer = new LinearLayout(this);
    composer.setGravity(Gravity.BOTTOM);
    composer.setBackgroundColor(Color.WHITE);
    composer.setPadding(dp(16), dp(12), dp(16), dp(12));
    chatRoot.addView(composer);
    EditText message = input("Escribe un mensaje…", false);
    chatInput = message;
    message.setText(chatDraft);
    message.setSingleLine(false);
    message.setMaxLines(5);
    LinearLayout.LayoutParams messageLp = new LinearLayout.LayoutParams(0, -2, 1);
    messageLp.rightMargin = dp(10);
    composer.addView(message, messageLp);
    Button send = Ui.iconButton(this, "send", "Enviar mensaje", Color.WHITE, GREEN, () -> {});
    composer.addView(send, new LinearLayout.LayoutParams(dp(52), dp(52)));
    send.setOnClickListener(
        v -> {
          String value = message.getText().toString().trim();
          if (value.isEmpty()) return;
          if (value.length() > 4000) {
            notify("El mensaje supera 4,000 caracteres.");
            return;
          }
          send.setEnabled(false);
          work(
              () -> {
                if (pendingMessage == null || !value.equals(pendingMessageText)) {
                  pendingMessage =
                      api.messageTicket(NativeApi.obj("version", 1, "text", value), "text", null);
                  pendingMessageText = value;
                }
                File pendingFile =
                    new File(
                        getFilesDir(), "chat-pending-" + pendingMessage.getString("id") + ".json");
                Files.write(pendingFile.toPath(), Crypto.utf8(pendingMessage.toString()));
                api.send(pendingMessage);
                pendingFile.delete();
                pendingMessage = null;
                pendingMessageText = "";
                return true;
              },
              ok -> {
                message.setText("");
                chatDraft = "";
                show(3);
              },
              () -> send.setEnabled(true));
        });
    toolbar.addView(
        Ui.iconButton(
            this, "history", "Actualizar conversación", GREEN, Color.TRANSPARENT, () -> show(3)));
    toolbar.addView(
        Ui.iconButton(
            this,
            "shield",
            "Reintentar mensajes pendientes",
            GREEN,
            Color.TRANSPARENT,
            () ->
                work(
                    () -> {
                      File[] queued =
                          getFilesDir()
                              .listFiles(
                                  (dir, name) ->
                                      name.startsWith("chat-pending-") && name.endsWith(".json"));
                      int count = 0;
                      if (queued != null)
                        for (File file : queued) {
                          JSONObject ticket =
                              new JSONObject(
                                  new String(
                                      Files.readAllBytes(file.toPath()),
                                      java.nio.charset.StandardCharsets.UTF_8));
                          if (api.userId.equals(ticket.optString("owner"))) {
                            api.send(ticket);
                            file.delete();
                            count++;
                          }
                        }
                      return count;
                    },
                    count -> {
                      notify(count + " mensajes confirmados.");
                      show(3);
                    })));
    chatMessages(messages, 0);
  }

  void chatMessages(LinearLayout target, long before) {
    work(
        () -> NativeApi.obj("rows", api.messages(before), "names", new JSONObject(api.authors())),
        response -> {
          JSONArray rows = response.getJSONArray("rows");
          JSONObject names = response.getJSONObject("names");
          if (rows.length() == 40) {
            long older = rows.getJSONObject(0).getLong("seq");
            Button more =
                button(
                    "Ver mensajes anteriores",
                    () -> {
                      target.removeAllViews();
                      chatMessages(target, older);
                    });
            target.addView(more);
          }
          for (int i = 0; i < rows.length(); i++) {
            JSONObject m = rows.getJSONObject(i), body = m.getJSONObject("body");
            LinearLayout c = column();
            boolean own = api.userId.equals(m.getString("created_by"));
            c.setPadding(dp(16), dp(12), dp(16), dp(12));
            c.setBackground(Ui.shape(this, own ? 0xffe0f0e6 : Color.WHITE, 20));
            LinearLayout.LayoutParams bubbleLp =
                new LinearLayout.LayoutParams(
                    (int) ((getResources().getDisplayMetrics().widthPixels - dp(36)) * .91), -2);
            bubbleLp.gravity = own ? Gravity.END : Gravity.START;
            bubbleLp.topMargin = dp(9);
            target.addView(c, bubbleLp);
            c.addView(
                text(
                    "@"
                        + names.optString(m.getString("created_by"), "Equipo")
                        + " · "
                        + when(m.getString("created_at")),
                    11,
                    MUTED));
            String kind = m.getString("kind");
            if (kind.equals("text") || kind.equals("image"))
              c.addView(text(body.optString("text"), 17, INK));
            if (kind.equals("sticker"))
              c.addView(text(sticker(body.optString("sticker")), 32, GREEN));
            if (body.has("product")) {
              JSONObject p = body.getJSONObject("product");
              c.addView(text(p.optString("description", p.optString("code")), 19, INK));
              c.addView(text(p.optString("code") + " · " + p.optString("salida"), 14, MUTED));
              if (!p.isNull("cents"))
                c.addView(
                    text(
                        String.format(Locale.US, "USD %.2f", p.getLong("cents") / 100.0)
                            + " · Precio al compartir",
                        20,
                        GREEN));
            }
            if (kind.equals("image"))
              c.addView(
                  button(
                      "Ver foto",
                      () ->
                          work(
                              () -> api.chatImage(m),
                              bytes -> {
                                ImageView image = new ImageView(this);
                                image.setAdjustViewBounds(true);
                                image.setImageBitmap(
                                    BitmapFactory.decodeByteArray(bytes, 0, bytes.length));
                                Arrays.fill(bytes, (byte) 0);
                                new AlertDialog.Builder(this)
                                    .setTitle("Foto del producto")
                                    .setView(image)
                                    .setPositiveButton("Cerrar", null)
                                    .show();
                              })));
          }
          if (rows.length() == 0) {
            TextView empty =
                text(
                    "La conversación empieza aquí.\nComparte una consulta con tu equipo.",
                    15,
                    MUTED);
            empty.setGravity(Gravity.CENTER);
            empty.setPadding(dp(10), dp(60), dp(10), dp(30));
            target.addView(empty);
          }
          if (before == 0 && target.getParent() instanceof ScrollView)
            target.post(() -> ((ScrollView) target.getParent()).fullScroll(View.FOCUS_DOWN));
        });
  }

  String sticker(String code) {
    switch (code) {
      case "ok":
        return "👍 Confirmado";
      case "checking":
        return "🔎 Lo estoy revisando";
      case "thanks":
        return "🙌 ¡Gracias!";
      case "box":
        return "📦 En bodega";
      case "wait":
        return "⏳ Un momento";
      case "done":
        return "✅ Resuelto";
      default:
        return "Sticker";
    }
  }

  void share(NativeApi.Result r, Long cents) {
    try {
      JSONObject p =
          NativeApi.obj(
              "version",
              1,
              "code",
              r.query,
              "identifier",
              "barcode",
              "result",
              r.match == null ? "missing" : "found",
              "description",
              r.match == null ? "" : NativeApi.text(r.match.product, "descripcion"),
              "ref",
              r.match == null ? "" : NativeApi.text(r.match.product, "ref"),
              "salida",
              r.match == null ? "" : NativeApi.text(r.match.doc, "salida"),
              "source",
              r.override == null ? "Factura" : "Administrador",
              "cents",
              cents,
              "checkedAt",
              Instant.ofEpochMilli(r.checkedAt).toString(),
              "invoiceDate",
              r.match == null ? "" : NativeApi.text(r.match.doc, "invoiceDate"),
              "sourceCode",
              r.lookupCode);
      new AlertDialog.Builder(this)
          .setTitle("Compartir producto")
          .setMessage(p.optString("description") + "\n" + p.optString("code"))
          .setNegativeButton("Cancelar", null)
          .setPositiveButton(
              "Compartir",
              (d, n) ->
                  work(
                      () -> {
                        JSONObject ticket =
                            api.messageTicket(
                                NativeApi.obj("version", 1, "product", p), "product", null);
                        api.send(ticket);
                        return true;
                      },
                      ok -> notify("Producto compartido en el chat.")))
          .show();
    } catch (Exception e) {
      error(e);
    }
  }

  void save(byte[] data, String name, String mime) {
    if (pendingDownload != null) {
      Arrays.fill(data, (byte) 0);
      notify("Termina el guardado anterior.");
      return;
    }
    pendingDownload = data;
    try {
      startActivityForResult(
          new Intent(Intent.ACTION_CREATE_DOCUMENT)
              .addCategory(Intent.CATEGORY_OPENABLE)
              .setType(mime)
              .putExtra(Intent.EXTRA_TITLE, name.replaceAll("[\\\\/\\p{Cntrl}]", "_")),
          SAVE);
    } catch (Exception e) {
      Arrays.fill(data, (byte) 0);
      pendingDownload = null;
      error(e);
    }
  }

  @Override
  protected void onActivityResult(int request, int result, Intent data) {
    super.onActivityResult(request, result, data);
    if (request == 14) {
      if (getPackageManager().canRequestPackageInstalls()) Updater.install(this);
      return;
    }
    if (request == SCAN && result == RESULT_OK && data != null) {
      if (data.getBooleanExtra("choosePhoto", false)) {
        startActivityForResult(
            new Intent(Intent.ACTION_OPEN_DOCUMENT)
                .addCategory(Intent.CATEGORY_OPENABLE)
                .setType("image/*"),
            PHOTO);
        return;
      }
      if (screen != 0) show(0);
      codeInput.setText(data.getStringExtra("code"));
      searchMode.setSelection(0);
      lookup();
    } else if (request == PHOTO && result == RESULT_OK && data != null && data.getData() != null) {
      Uri uri = data.getData();
      work(
          () -> {
            BitmapFactory.Options options = new BitmapFactory.Options();
            options.inJustDecodeBounds = true;
            try (InputStream in = getContentResolver().openInputStream(uri)) {
              BitmapFactory.decodeStream(in, null, options);
            }
            if ((long) options.outWidth * options.outHeight > 60000000)
              throw new Exception("La foto es demasiado grande. Recorta la etiqueta.");
            options.inSampleSize =
                Math.max(1, Math.max(options.outWidth, options.outHeight) / 2400);
            options.inJustDecodeBounds = false;
            Bitmap bitmap;
            try (InputStream in = getContentResolver().openInputStream(uri)) {
              bitmap = BitmapFactory.decodeStream(in, null, options);
            }
            if (bitmap == null) throw new Exception("No se pudo leer la foto.");
            try {
              int w = bitmap.getWidth(), h = bitmap.getHeight();
              int[] pixels = new int[w * h];
              bitmap.getPixels(pixels, 0, w, 0, 0, w, h);
              RGBLuminanceSource image = new RGBLuminanceSource(w, h, pixels);
              MultiFormatReader reader = new MultiFormatReader();
              Map<com.google.zxing.DecodeHintType, Object> hints =
                  new java.util.EnumMap<>(com.google.zxing.DecodeHintType.class);
              hints.put(com.google.zxing.DecodeHintType.TRY_HARDER, true);
              com.google.zxing.LuminanceSource source = image;
              for (int turn = 0; turn < 2; turn++) {
                for (int inverted = 0; inverted < 2; inverted++) {
                  try {
                    return reader
                        .decode(
                            new BinaryBitmap(
                                new HybridBinarizer(inverted == 0 ? source : source.invert())),
                            hints)
                        .getText();
                  } catch (com.google.zxing.ReaderException unreadable) {
                    reader.reset();
                  }
                }
                if (turn == 0) {
                  byte[] original = image.getMatrix(), rotated = new byte[w * h];
                  for (int y = 0; y < h; y++)
                    for (int x = 0; x < w; x++) rotated[x * h + h - y - 1] = original[y * w + x];
                  source =
                      new com.google.zxing.PlanarYUVLuminanceSource(
                          rotated, h, w, 0, 0, h, w, false);
                }
              }
              throw new Exception(
                  "No se distinguieron las barras. Prueba una foto más cercana o escribe el"
                      + " código.");
            } finally {
              bitmap.recycle();
            }
          },
          code -> {
            if (screen != 0) show(0);
            codeInput.setText(code);
            searchMode.setSelection(0);
            lookup();
          });
    } else if (request == SAVE && pendingDownload != null) {
      byte[] bytes = pendingDownload;
      pendingDownload = null;
      if (result != RESULT_OK || data == null || data.getData() == null) {
        Arrays.fill(bytes, (byte) 0);
        notify("Guardado cancelado. Los originales se conservan en el Archivo.");
        return;
      }
      Uri destination = data.getData();
      work(
          () -> {
            try (OutputStream out = getContentResolver().openOutputStream(destination, "wt")) {
              if (out == null) throw new Exception("No se pudo abrir el destino.");
              out.write(bytes);
              out.flush();
            } finally {
              Arrays.fill(bytes, (byte) 0);
            }
            return true;
          },
          ok -> notify("Archivo guardado correctamente."));
    }
  }

  void showDialog(String title, View body) {
    ScrollView scroll = new ScrollView(this);
    scroll.addView(body);
    AlertDialog dialog =
        new AlertDialog.Builder(this)
            .setTitle(title)
            .setView(scroll)
            .setPositiveButton("Cerrar", null)
            .create();
    dialog.show();
    track(dialog);
    if (dialog.getWindow() != null) dialog.getWindow().setLayout(-1, -1);
  }

  void track(Dialog dialog) {
    dialog.setOwnerActivity(this);
    privateDialogs.add(dialog);
    if (dialog.getWindow() != null)
      dialog
          .getWindow()
          .getDecorView()
          .addOnAttachStateChangeListener(
              new View.OnAttachStateChangeListener() {
                public void onViewAttachedToWindow(View view) {}

                public void onViewDetachedFromWindow(View view) {
                  privateDialogs.remove(dialog);
                }
              });
  }

  void closePrivateDialogs() {
    for (Dialog dialog : new ArrayList<>(privateDialogs)) dialog.dismiss();
    privateDialogs.clear();
  }

  String when(String value) {
    try {
      return DateTimeFormatter.ofPattern("dd/MM/yyyy, h:mm a", new Locale("es", "PA"))
          .withZone(ZoneId.of("America/Panama"))
          .format(Instant.parse(value));
    } catch (Exception e) {
      return value;
    }
  }

  String date(String value) {
    return value.matches("[0-9]{4}-[0-9]{2}-[0-9]{2}")
        ? value.substring(8, 10) + "/" + value.substring(5, 7) + "/" + value.substring(0, 4)
        : value.isEmpty() ? "No confirmada en el documento" : value;
  }

  void checkUpdate() {
    Updater.check(this, io, main);
  }

  void startLive() {
    if (destroyed || paused || !api.authenticated() || realtime != null) return;
    Updater.checkDaily(this, io, main);
    int e = api.epoch;
    realtime =
        new Realtime(
            api.url,
            api.publicKey,
            api.workspace,
            () ->
                io.submit(
                        () -> {
                          if (e != api.epoch) throw new Exception("La sesión cambió.");
                          return api.realtimeToken();
                        })
                    .get(20, java.util.concurrent.TimeUnit.SECONDS),
            new Realtime.Events() {
              public void changed(String table) {
                main.post(
                    () -> {
                      if (destroyed || paused || e != api.epoch) return;
                      if (table.equals("all")
                          || table.equals("mega_audit_records")
                          || table.equals("mega_chat_products")) api.catalogChecked = 0;
                      main.removeCallbacks(syncChanges);
                      main.postDelayed(syncChanges, 500);
                    });
              }

              public void status(boolean connected) {
                main.post(
                    () -> {
                      if (e == api.epoch && !destroyed) {
                        live = connected;
                        MainActivity.this.status(
                            connected
                                ? "● En tiempo real · @" + api.username
                                : "Reconectando · Comprobaciones de respaldo activas");
                      }
                    });
              }
            });
    main.removeCallbacks(accessTick);
    main.postDelayed(accessTick, 15000);
  }

  void stopLive() {
    if (realtime != null) {
      realtime.close();
      realtime = null;
    }
    live = false;
    main.removeCallbacks(accessTick);
    main.removeCallbacks(syncChanges);
  }

  void refreshNative() {
    if (destroyed || paused || !api.authenticated()) return;
    if (screen == 0)
      work(
          () -> {
            String summary = api.prepare(null);
            NativeApi.Result r = lastResult;
            if (r != null) return api.lookup(r.query, r.byReference);
            return null;
          },
          r -> {
            if (r != null) renderResult(r);
            else status(api.summary());
          });
    else if (screen == 2) show(2);
    else status("Hay cambios del equipo. Actualiza esta sección para verlos.");
  }

  void logout() {
    stopLive();
    closePrivateDialogs();
    api.clear();
    lastResult = null;
    pendingMessage = null;
    pendingMessageText = "";
    if (pendingDownload != null) {
      Arrays.fill(pendingDownload, (byte) 0);
      pendingDownload = null;
    }
    loginView();
  }

  @Override
  public void onBackPressed() {
    if (screen > 0) show(0);
    else super.onBackPressed();
  }

  @Override
  protected void onPause() {
    paused = true;
    stopLive();
    super.onPause();
  }

  @Override
  protected void onResume() {
    super.onResume();
    paused = false;
    if (api != null && api.authenticated() && screen >= 0)
      work(
          () -> {
            api.checkAccess(false);
            return true;
          },
          ok -> startLive());
  }

  @Override
  protected void onDestroy() {
    destroyed = true;
    stopLive();
    closePrivateDialogs();
    api.clear();
    if (pendingDownload != null) Arrays.fill(pendingDownload, (byte) 0);
    io.shutdown();
    super.onDestroy();
  }
}
