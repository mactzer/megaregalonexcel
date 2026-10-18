package io.github.mactzer.megacontrol;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.text.Normalizer;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import org.json.JSONArray;
import org.json.JSONObject;
import org.json.JSONTokener;

/** Direct Supabase client. No web runtime, privileged key, new database or HTML. */
final class NativeApi {
  interface Transport {
    HttpURLConnection open(URL url) throws Exception;
  }

  interface Cache {
    String read() throws Exception;

    void write(String encrypted) throws Exception;
  }

  interface Progress {
    void update(String message);
  }

  final String workspace, url, publicKey;
  final Transport transport;
  volatile int epoch;
  volatile String username = "", userId = "", role = "";
  private String access = "", refresh = "";
  private long expires, accessChecked;
  volatile Crypto.Team team;
  final Cache cache;
  final Map<String, JSONObject> catalog = new LinkedHashMap<>(), sources = new LinkedHashMap<>();
  final Map<String, List<Match>> barcodes = new HashMap<>(), references = new HashMap<>();
  private final Map<String, JSONObject> pendingPrices = new HashMap<>();
  private Map<String, String> authors = new HashMap<>();
  private long authorsChecked;
  int failedDocuments;
  volatile long catalogChecked;
  private String catalogSignature = "";

  NativeApi(Cache cache) {
    this(
        BuildConfig.SUPABASE_URL,
        BuildConfig.PUBLIC_KEY,
        BuildConfig.WORKSPACE,
        cache,
        u -> (HttpURLConnection) u.openConnection());
  }

  NativeApi(String url, String key, String workspace, Cache cache, Transport transport) {
    this.url = url;
    publicKey = key;
    this.workspace = workspace;
    this.cache = cache;
    this.transport = transport;
  }

  static JSONObject obj(Object... items) throws Exception {
    JSONObject o = new JSONObject();
    for (int i = 0; i < items.length; i += 2)
      o.put((String) items[i], items[i + 1] == null ? JSONObject.NULL : items[i + 1]);
    return o;
  }

  static String text(JSONObject j, String key) {
    return j.isNull(key) ? "" : j.optString(key, "");
  }

  static String canonical(String s) {
    s = s.trim();
    return s.matches("[0-9]{12}") ? "0" + s : s;
  }

  static String normalized(String s) {
    return Normalizer.normalize(s, Normalizer.Form.NFD)
        .replaceAll("\\p{M}", "")
        .toUpperCase(Locale.ROOT)
        .replaceAll("\\s+", " ")
        .trim();
  }

  static Double value(JSONObject j, String key) {
    if (j.isNull(key) || "".equals(j.opt(key))) return null;
    Object o = j.opt(key);
    return o instanceof Number && Double.isFinite(((Number) o).doubleValue())
        ? ((Number) o).doubleValue()
        : null;
  }

  static String now() {
    return java.time.Instant.now().toString();
  }

  private void guard(int e) throws Exception {
    if (epoch != e) throw new Exception("La sesión cambió. Inicia sesión nuevamente.");
  }

  boolean authenticated() {
    return team != null && !access.isEmpty() && !userId.isEmpty();
  }

  String realtimeToken() throws Exception {
    if (!authenticated()) throw new Exception("La sesión terminó.");
    refresh();
    return access;
  }

  synchronized void clear() {
    epoch++;
    access = refresh = username = userId = role = "";
    expires = accessChecked = 0;
    if (team != null) team.clear();
    team = null;
    catalog.clear();
    sources.clear();
    barcodes.clear();
    references.clear();
    pendingPrices.clear();
    authors.clear();
    catalogSignature = "";
    failedDocuments = 0;
    catalogChecked = 0;
  }

  private byte[] exchange(
      String path, String method, byte[] data, boolean anonymous, boolean binary) throws Exception {
    int e = epoch;
    if (!anonymous && (!authenticated() && access.isEmpty()))
      throw new Exception("Inicia sesión para continuar.");
    HttpURLConnection c = transport.open(new URL(url + path));
    c.setInstanceFollowRedirects(false);
    c.setConnectTimeout(5000);
    c.setReadTimeout(binary ? 30000 : 12000);
    c.setRequestMethod(method);
    c.setRequestProperty("apikey", publicKey);
    c.setRequestProperty("Authorization", "Bearer " + (anonymous ? publicKey : access));
    c.setRequestProperty("Cache-Control", "no-store");
    if (data != null) {
      c.setDoOutput(true);
      c.setRequestProperty(
          "Content-Type", binary ? "application/octet-stream" : "application/json");
      try (java.io.OutputStream out = c.getOutputStream()) {
        out.write(data);
      }
    }
    try {
      int status = c.getResponseCode();
      InputStream input = status >= 400 ? c.getErrorStream() : c.getInputStream();
      ByteArrayOutputStream bytes = new ByteArrayOutputStream();
      if (input != null)
        try (InputStream in = input) {
          byte[] b = new byte[16384];
          int n;
          while ((n = in.read(b)) != -1) {
            bytes.write(b, 0, n);
            if (bytes.size() > (binary ? 26 * 1024 * 1024 : 24 * 1024 * 1024))
              throw new Exception("La respuesta supera el tamaño permitido.");
          }
        }
      guard(e);
      byte[] result = bytes.toByteArray();
      if (status >= 400 || status < 200 || status >= 300) {
        String code = "";
        try {
          JSONObject error = new JSONObject(new String(result, StandardCharsets.UTF_8));
          code = error.optString("code", error.optString("error_code", ""));
        } catch (Exception ignored) {
        }
        if (status == 401 && !anonymous) {
          clear();
          throw new Exception("Tu sesión ha terminado. Inicia sesión nuevamente.");
        }
        if (status == 403) throw new Exception("Tu cuenta no tiene permiso para esta operación.");
        if (status == 429)
          throw new Exception("Demasiados intentos. Espera un momento e inténtalo nuevamente.");
        if ("40001".equals(code))
          throw new Exception("Otro administrador cambió estos datos. Actualiza antes de guardar.");
        if (path.startsWith("/auth/"))
          throw new Exception(
              "El usuario o la contraseña no coinciden con tu cuenta de MegaControl.");
        throw new Exception(
            "No se confirmó la operación (HTTP " + status + "). Reintenta sin cambiar los datos.");
      }
      return result;
    } finally {
      c.disconnect();
    }
  }

  Object request(String path, String method, JSONObject data, boolean anonymous) throws Exception {
    if (!anonymous) refresh();
    byte[] out =
        exchange(
            path, method, data == null ? null : Crypto.utf8(data.toString()), anonymous, false);
    if (out.length == 0) return JSONObject.NULL;
    return new JSONTokener(new String(out, StandardCharsets.UTF_8)).nextValue();
  }

  JSONArray list(String table, String query) throws Exception {
    return (JSONArray)
        request(
            "/rest/v1/" + table + "?workspace_id=eq." + workspace + "&" + query,
            "GET",
            null,
            false);
  }

  Object rpc(String name, JSONObject data) throws Exception {
    data.put("p_workspace_id", workspace);
    return request("/rest/v1/rpc/" + name, "POST", data, false);
  }

  private JSONArray own(String table, String columns) throws Exception {
    return list(table, "user_id=eq." + userId + "&select=" + columns);
  }

  private synchronized void accept(JSONObject s, String expectedUser, int expectedEpoch)
      throws Exception {
    guard(expectedEpoch);
    JSONObject user = s.getJSONObject("user");
    if (!user.getString("email").equals(expectedUser + "@usuarios.megaregalonexcel.invalid"))
      throw new Exception("La sesión no corresponde al usuario.");
    String id = user.getString("id");
    UUID.fromString(id);
    if (!userId.isEmpty() && !userId.equals(id)) throw new Exception("La sesión cambió de cuenta.");
    userId = id;
    username = expectedUser;
    access = s.getString("access_token");
    refresh = s.getString("refresh_token");
    expires = System.currentTimeMillis() + s.optLong("expires_in", 3600) * 1000;
  }

  void login(String raw, char[] password) throws Exception {
    clear();
    int e = epoch;
    Crypto.Account account = new Crypto.Account(raw, password, workspace);
    try {
      JSONObject s =
          (JSONObject)
              request(
                  "/auth/v1/token?grant_type=password",
                  "POST",
                  obj(
                      "email",
                      account.username + "@usuarios.megaregalonexcel.invalid",
                      "password",
                      account.authPassword),
                  true);
      guard(e);
      accept(s, account.username, e);
      JSONArray members = own("mega_audit_members", "role");
      if (members.length() != 1)
        throw new Exception("Tu cuenta no tiene acceso autorizado a MegaControl.");
      role = members.getJSONObject(0).getString("role");
      if (!role.equals("admin") && !role.equals("user")) throw new Exception("Permisos inválidos.");
      JSONArray workspaces =
          (JSONArray)
              request(
                  "/rest/v1/mega_audit_workspace?id=eq." + workspace + "&select=key_fingerprint",
                  "GET",
                  null,
                  false);
      JSONArray keys = own("mega_audit_user_keys", "wrapped_key");
      if (keys.length() != 1 || workspaces.length() != 1)
        throw new Exception("El administrador debe completar el acceso cifrado de tu cuenta.");
      Crypto.Team unlocked = account.unlock(keys.getJSONObject(0).getString("wrapped_key"));
      guard(e);
      if (!unlocked.fingerprint.equals(workspaces.getJSONObject(0).getString("key_fingerprint"))) {
        unlocked.clear();
        throw new Exception("La clave de tu cuenta no coincide con el equipo.");
      }
      team = unlocked;
      accessChecked = System.currentTimeMillis();
    } catch (Exception ex) {
      if (e == epoch) clear();
      throw ex;
    } finally {
      account.clear();
      Arrays.fill(password, '\0');
    }
  }

  private void refresh() throws Exception {
    if (access.isEmpty() || expires > System.currentTimeMillis() + 45000) return;
    int e = epoch;
    JSONObject s =
        (JSONObject)
            request(
                "/auth/v1/token?grant_type=refresh_token",
                "POST",
                obj("refresh_token", refresh),
                true);
    guard(e);
    accept(s, username, e);
  }

  void checkAccess(boolean admin) throws Exception {
    if (!authenticated()) throw new Exception("Inicia sesión para continuar.");
    if (!admin && System.currentTimeMillis() - accessChecked < 15000) return;
    JSONArray rows = own("mega_audit_members", "role");
    if (rows.length() != 1) {
      clear();
      throw new Exception("Tu cuenta ya no tiene acceso al equipo.");
    }
    role = rows.getJSONObject(0).getString("role");
    if (!role.equals("admin") && !role.equals("user")) {
      clear();
      throw new Exception("Tu cuenta ya no tiene acceso al equipo.");
    }
    accessChecked = System.currentTimeMillis();
    if (admin && !role.equals("admin"))
      throw new Exception("Solo administradores pueden editar precios.");
  }

  JSONObject metadata(JSONObject record) throws Exception {
    if (!workspace.equals(record.getString("workspace_id")))
      throw new Exception("El documento no pertenece a MegaControl.");
    JSONObject m =
        new JSONObject(
            team.decryptText(
                record.getString("encrypted_metadata"), record.getString("id") + "|metadata"));
    if (!text(m, "salida_numero").matches("[0-9]{1,60}")
        || !m.has("row_count")
        || !m.has("total_units")) throw new Exception("Metadatos incompletos.");
    m.put("record", record);
    return m;
  }

  JSONArray archive(int offset, String exact) throws Exception {
    checkAccess(false);
    String query =
        "select=*&duplicate_of=is.null&order=created_at.desc,id.desc&limit=25&offset=" + offset;
    if (!exact.trim().isEmpty()) {
      if (!exact.trim().matches("[0-9]{1,60}"))
        throw new Exception("Escribe un número de salida válido.");
      query += "&salida_tag=eq." + team.salidaTag(exact.trim());
    }
    JSONArray records = list("mega_audit_records", query), out = new JSONArray();
    for (int i = 0; i < records.length(); i++) out.put(metadata(records.getJSONObject(i)));
    return out;
  }

  byte[] document(JSONObject record, String kind) throws Exception {
    if (!kind.equals("pdf") && !kind.equals("excel")) throw new Exception("Documento inválido.");
    checkAccess(false);
    refresh();
    UUID.fromString(record.getString("id"));
    UUID.fromString(record.getString("created_by"));
    byte[] cipher =
        exchange(
            "/storage/v1/object/authenticated/mega-audit-documents/"
                + workspace
                + "/"
                + record.getString("created_by")
                + "/"
                + record.getString("id")
                + "/"
                + kind
                + ".bin",
            "GET",
            null,
            false,
            true);
    try {
      return team.decrypt(cipher, record.getString("id") + "|" + kind);
    } finally {
      Arrays.fill(cipher, (byte) 0);
    }
  }

  private JSONArray snapshot() throws Exception {
    JSONArray all = new JSONArray();
    for (int offset = 0; ; offset += 500) {
      JSONArray page =
          list(
              "mega_audit_catalog_records",
              "select=id,created_at,metadata_revision&duplicate_of=is.null&order=created_at.desc,id.desc&limit=500&offset="
                  + offset);
      for (int i = 0; i < page.length(); i++) all.put(page.getJSONObject(i));
      if (page.length() < 500) return all;
    }
  }

  String prepare(Progress progress) throws Exception {
    checkAccess(false);
    int e = epoch;
    JSONArray rows = snapshot();
    guard(e);
    String signature = rows.toString();
    if (signature.equals(catalogSignature) && !catalog.isEmpty()) {
      catalogChecked = System.currentTimeMillis();
      return summary();
    }
    Map<String, JSONObject> previous = new HashMap<>(catalog);
    if (previous.isEmpty() && cache != null)
      try {
        JSONObject local = new JSONObject(team.decryptText(cache.read(), "native-catalog-v1"));
        JSONArray saved = local.getJSONArray("documents");
        for (int i = 0; i < saved.length(); i++) {
          JSONObject doc = saved.getJSONObject(i);
          previous.put(doc.getString("id"), doc);
        }
      } catch (Exception ignored) {
      }
    Map<String, JSONObject> next = new LinkedHashMap<>(), currentSources = new LinkedHashMap<>();
    int missing = 0;
    for (int start = 0; start < rows.length(); start += 50) {
      StringBuilder ids = new StringBuilder();
      for (int i = start; i < Math.min(start + 50, rows.length()); i++) {
        String id = rows.getJSONObject(i).getString("id");
        UUID.fromString(id);
        if (ids.length() > 0) ids.append(',');
        ids.append(id);
      }
      JSONArray shared =
          list(
              "mega_product_catalog",
              "record_id=in.("
                  + ids
                  + ")&select=record_id,metadata_revision,encrypted_catalog&limit=50");
      Map<String, JSONObject> byId = new HashMap<>();
      for (int i = 0; i < shared.length(); i++)
        byId.put(shared.getJSONObject(i).getString("record_id"), shared.getJSONObject(i));
      for (int i = start; i < Math.min(start + 50, rows.length()); i++) {
        JSONObject row = rows.getJSONObject(i);
        String id = row.getString("id"), revision = row.getString("metadata_revision");
        currentSources.put(id, row);
        JSONObject doc = null, old = previous.get(id), saved = byId.get(id);
        if (old != null && revision.equals(old.optString("revision"))) doc = old;
        else if (saved != null && revision.equals(saved.optString("metadata_revision")))
          try {
            doc =
                new JSONObject(
                    team.decryptText(
                        saved.getString("encrypted_catalog"),
                        "shared-catalog-v1|" + id + "|" + revision));
            if (!row.getString("created_at").equals(doc.getString("date"))) doc = null;
          } catch (Exception ignored) {
          }
        if (doc == null) {
          missing++;
          continue;
        }
        doc.getJSONArray("products");
        doc.put("id", id);
        doc.put("revision", revision);
        next.put(id, doc);
        guard(e);
        if (progress != null)
          progress.update("Preparando catálogo: " + (i + 1) + " de " + rows.length());
      }
    }
    guard(e);
    catalog.clear();
    catalog.putAll(next);
    sources.clear();
    sources.putAll(currentSources);
    failedDocuments = missing;
    index();
    catalogChecked = System.currentTimeMillis();
    catalogSignature = signature;
    if (cache != null) {
      JSONArray saved = new JSONArray();
      for (JSONObject doc : catalog.values()) saved.put(doc);
      cache.write(team.seal(obj("version", 1, "documents", saved).toString(), "native-catalog-v1"));
    }
    return summary();
  }

  String summary() {
    return barcodes.size()
        + " códigos · "
        + catalog.size()
        + " documentos preparados"
        + (failedDocuments > 0
            ? " · " + failedDocuments + " pendientes de índice"
            : " · Índice completo");
  }

  private void index() throws Exception {
    barcodes.clear();
    references.clear();
    for (JSONObject doc : catalog.values()) {
      JSONArray products = doc.getJSONArray("products");
      Map<String, Boolean> seen = new HashMap<>();
      for (int i = 0; i < products.length(); i++) {
        JSONObject product = products.getJSONObject(i);
        String code = canonical(text(product, "codigo")),
            ref = normalized(text(product, "ref")),
            key = code + "|" + product.opt("pventa") + "|" + ref;
        if (seen.put(key, true) != null) continue;
        Match m = new Match(product, doc);
        if (!code.isEmpty()) barcodes.computeIfAbsent(code, k -> new ArrayList<>()).add(m);
        if (!ref.isEmpty()) references.computeIfAbsent(ref, k -> new ArrayList<>()).add(m);
      }
    }
    for (List<Match> list : barcodes.values()) Collections.sort(list, NEWEST);
    for (List<Match> list : references.values()) Collections.sort(list, NEWEST);
  }

  static final Comparator<Match> NEWEST =
      (a, b) -> {
        boolean x = "salida".equals(a.doc.optString("kind", "salida")),
            y = "salida".equals(b.doc.optString("kind", "salida"));
        if (x != y) return x ? -1 : 1;
        int d = text(b.doc, "invoiceDate").compareTo(text(a.doc, "invoiceDate"));
        if (d != 0) return d;
        String an = text(a.doc, "salida").replaceFirst("^0+(?!$)", ""),
            bn = text(b.doc, "salida").replaceFirst("^0+(?!$)", "");
        if (an.matches("[0-9]+") && bn.matches("[0-9]+")) {
          d = Integer.compare(bn.length(), an.length());
          if (d == 0) d = bn.compareTo(an);
          if (d != 0) return d;
        }
        return text(a.doc, "id").compareTo(text(b.doc, "id"));
      };

  static final class Match {
    final JSONObject product, doc;

    Match(JSONObject product, JSONObject doc) {
      this.product = product;
      this.doc = doc;
    }
  }

  static final class Result {
    String query, lookupCode;
    Match match;
    List<Match> history = new ArrayList<>();
    JSONObject override;
    boolean incomplete, ambiguous, conflicting, byReference;
    long checkedAt;
  }

  List<Match> search(String raw) throws Exception {
    checkAccess(false);
    if (catalogChecked == 0) prepare(null);
    String[] terms = normalized(raw).split(" ");
    List<Match> out = new ArrayList<>();
    for (List<Match> list : barcodes.values()) {
      Match m = list.get(0);
      String hay = normalized(text(m.product, "descripcion") + " " + text(m.product, "ref"));
      boolean ok = true;
      for (String term : terms) if (!hay.contains(term)) ok = false;
      if (ok) out.add(m);
      if (out.size() == 50) break;
    }
    return out;
  }

  Result lookup(String raw, boolean reference) throws Exception {
    checkAccess(false);
    if (catalogChecked == 0 || System.currentTimeMillis() - catalogChecked > 120000) prepare(null);
    String code = reference ? raw.trim() : canonical(raw);
    if (code.isEmpty() || code.length() > 80) throw new Exception("Escribe un código válido.");
    Result r = new Result();
    r.query = raw;
    r.byReference = reference;
    r.incomplete = failedDocuments > 0;
    List<Match> history =
        (reference ? references : barcodes).get(reference ? normalized(code) : code);
    if (history != null && !history.isEmpty()) {
      r.history = new ArrayList<>(history);
      r.match = history.get(0);
      r.lookupCode = canonical(text(r.match.product, "codigo"));
      if (r.lookupCode.isEmpty()) r.lookupCode = text(r.match.product, "ref");
      if (reference) {
        String first = canonical(text(r.match.product, "codigo"));
        for (Match m : history)
          if (!canonical(text(m.product, "codigo")).equals(first)) r.ambiguous = true;
      }
      for (Match m : history)
        if (text(m.doc, "invoiceDate").equals(text(r.match.doc, "invoiceDate"))
            && text(m.doc, "salida").equals(text(r.match.doc, "salida"))
            && !java.util.Objects.equals(
                value(m.product, "pventa"), value(r.match.product, "pventa"))) r.conflicting = true;
    }
    if (!reference) {
      JSONObject registered = registered(code);
      if (registered != null) {
        JSONObject p = registered.getJSONObject("product");
        String source = text(p, "sourceCode");
        List<Match> linked = barcodes.get(canonical(source));
        if (!source.isEmpty() && linked != null && !linked.isEmpty()) {
          Match original = linked.get(0);
          JSONObject alias = new JSONObject(original.product.toString());
          alias.put("codigo", text(p, "code"));
          r.match = new Match(alias, original.doc);
          r.history = new ArrayList<>(linked);
          r.lookupCode = canonical(source);
        } else {
          JSONObject product =
              obj(
                  "codigo",
                  text(p, "code"),
                  "descripcion",
                  text(p, "description"),
                  "ref",
                  text(p, "ref"),
                  "pventa",
                  p.isNull("cents") ? null : p.getLong("cents") / 100.0);
          r.match =
              new Match(
                  product,
                  obj(
                      "kind",
                      "registered",
                      "salida",
                      text(p, "salida"),
                      "invoiceDate",
                      text(p, "invoiceDate"),
                      "registered_at",
                      registered.getString("updated_at")));
          r.lookupCode = source.isEmpty() ? code : source;
        }
      }
    }
    if (r.match != null && !r.ambiguous) {
      r.override = price(r.lookupCode);
      if (r.override == null
          && r.match.doc.optBoolean("reviewed")
          && !text(r.match.product, "ref").isEmpty()) {
        JSONObject byRef = price(text(r.match.product, "ref"));
        if (byRef != null) {
          r.override = byRef;
          r.lookupCode = text(r.match.product, "ref");
        }
      }
    }
    r.checkedAt = System.currentTimeMillis();
    return r;
  }

  JSONObject registered(String code) throws Exception {
    String tag = team.tag("chat-product|" + canonical(code));
    JSONArray rows = list("mega_chat_products", "product_tag=eq." + tag + "&select=*&limit=2");
    if (rows.length() == 0) return null;
    if (rows.length() != 1) throw new Exception("Registro de producto ambiguo.");
    JSONObject row = rows.getJSONObject(0),
        p =
            new JSONObject(
                team.decryptText(
                    row.getString("encrypted_product"),
                    "chat-product-v1|" + tag + "|" + row.getLong("version")));
    if (!canonical(code).equals(canonical(p.getString("code"))))
      throw new Exception("Código de registro inválido.");
    row.put("product", p);
    return row;
  }

  private JSONObject decodePrice(JSONObject row, String code, String tag) throws Exception {
    if (!workspace.equals(row.getString("workspace_id"))
        || !tag.equals(row.getString("product_tag")))
      throw new Exception("El precio no corresponde al producto.");
    JSONObject p =
        new JSONObject(
            team.decryptText(
                row.getString("encrypted_price"),
                "product-price-v1|" + tag + "|" + row.getLong("version")));
    if (!code.equals(p.getString("code"))
        || p.getLong("cents") < 0
        || p.getLong("cents") > 999999999) throw new Exception("Precio compartido inválido.");
    p.put("version", row.getLong("version"));
    p.put("updated_at", row.getString("updated_at"));
    p.put("updated_by", row.getString("updated_by"));
    return p;
  }

  JSONObject price(String raw) throws Exception {
    String code = canonical(raw), tag = team.tag(code);
    JSONArray rows = list("mega_product_prices", "product_tag=eq." + tag + "&select=*&limit=2");
    if (rows.length() > 1) throw new Exception("Precio compartido ambiguo.");
    return rows.length() == 0 ? null : decodePrice(rows.getJSONObject(0), code, tag);
  }

  JSONObject setPrice(String raw, long cents, long expected, String reason, Long previous)
      throws Exception {
    return setPrice(raw, cents, expected, reason, previous, null);
  }

  JSONObject setPrice(
      String raw, long cents, long expected, String reason, Long previous, Long reverted)
      throws Exception {
    checkAccess(true);
    if (cents < 0
        || cents > 999999999
        || expected < 0
        || reason.trim().isEmpty()
        || reason.length() > 500)
      throw new Exception("Revisa el precio y escribe el motivo del cambio.");
    String code = canonical(raw), tag = team.tag(code);
    JSONObject body =
        obj("code", code, "cents", cents, "reason", reason.trim(), "previousCents", previous);
    String signature = expected + "|" + body.toString();
    JSONObject ticket = pendingPrices.get(tag);
    if (reverted != null) {
      body.put("revertedFrom", reverted);
      signature = expected + "|" + body.toString();
    }
    if (ticket == null || !signature.equals(ticket.getString("signature"))) {
      ticket =
          obj(
              "signature",
              signature,
              "encrypted",
              team.seal(body.toString(), "product-price-v1|" + tag + "|" + (expected + 1)));
      pendingPrices.put(tag, ticket);
    }
    Object response =
        rpc(
            "mega_product_price_set",
            obj(
                "p_product_tag",
                tag,
                "p_encrypted_price",
                ticket.getString("encrypted"),
                "p_expected_version",
                expected));
    JSONObject row =
        response instanceof JSONArray
            ? ((JSONArray) response).getJSONObject(0)
            : (JSONObject) response;
    if (row.getLong("version") != expected + 1
        || !userId.equals(row.getString("updated_by"))
        || !ticket.getString("encrypted").equals(row.getString("encrypted_price")))
      throw new Exception("No se confirmó el cambio. Reintenta con los mismos datos.");
    JSONObject out = decodePrice(row, code, tag);
    pendingPrices.remove(tag);
    return out;
  }

  JSONArray priceHistory(String raw, int offset) throws Exception {
    checkAccess(false);
    String code = canonical(raw), tag = team.tag(code);
    JSONArray
        rows =
            list(
                "mega_product_price_history",
                "product_tag=eq." + tag + "&select=*&order=version.desc&limit=20&offset=" + offset),
        out = new JSONArray();
    for (int i = 0; i < rows.length(); i++) out.put(decodePrice(rows.getJSONObject(i), code, tag));
    return out;
  }

  Map<String, String> authors() throws Exception {
    if (System.currentTimeMillis() - authorsChecked < 120000 && !authors.isEmpty()) return authors;
    JSONArray rows = (JSONArray) rpc("mega_audit_authors", obj());
    Map<String, String> result = new HashMap<>();
    for (int i = 0; i < rows.length(); i++) {
      JSONObject r = rows.getJSONObject(i);
      result.put(r.getString("user_id"), r.getString("username"));
    }
    authors = result;
    authorsChecked = System.currentTimeMillis();
    return authors;
  }

  JSONObject queryTicket(Result r) throws Exception {
    Long cents =
        r.override != null
            ? r.override.getLong("cents")
            : r.match != null && value(r.match.product, "pventa") != null && !r.conflicting
                ? Math.round(value(r.match.product, "pventa") * 100)
                : null;
    String id = UUID.randomUUID().toString();
    JSONObject value =
        obj(
            "version",
            1,
            "code",
            r.query,
            "label",
            r.match != null && !r.ambiguous
                ? "Encontrado"
                : r.incomplete || r.ambiguous ? "Consulta incompleta" : "Sin coincidencia",
            "description",
            r.match == null ? "" : text(r.match.product, "descripcion"),
            "cents",
            cents,
            "salida",
            r.match == null ? "" : text(r.match.doc, "salida"));
    return obj(
        "id",
        id,
        "owner",
        userId,
        "encrypted",
        team.seal(value.toString(), "product-query-v1|" + id));
  }

  void saveQuery(JSONObject ticket) throws Exception {
    checkAccess(false);
    if (!userId.equals(ticket.getString("owner")))
      throw new Exception("Consulta pendiente de otra cuenta.");
    Object result =
        rpc(
            "mega_product_query_add",
            obj(
                "p_id",
                ticket.getString("id"),
                "p_encrypted_query",
                ticket.getString("encrypted")));
    JSONObject row =
        result instanceof JSONArray ? ((JSONArray) result).getJSONObject(0) : (JSONObject) result;
    if (!ticket.getString("id").equals(row.getString("id"))
        || !ticket.getString("encrypted").equals(row.getString("encrypted_query")))
      throw new Exception("El historial no se confirmó.");
  }

  JSONArray queries() throws Exception {
    checkAccess(false);
    JSONArray
        rows = list("mega_product_queries", "select=*&order=created_at.desc,id.desc&limit=20"),
        out = new JSONArray();
    for (int i = 0; i < rows.length(); i++) {
      JSONObject row = rows.getJSONObject(i),
          q =
              new JSONObject(
                  team.decryptText(
                      row.getString("encrypted_query"), "product-query-v1|" + row.getString("id")));
      q.put("created_at", row.getString("created_at"));
      q.put("created_by", row.getString("created_by"));
      out.put(q);
    }
    return out;
  }

  JSONArray messages(long before) throws Exception {
    checkAccess(false);
    JSONArray
        rows =
            list(
                "mega_chat_messages",
                "select=*&order=seq.desc&limit=40" + (before > 0 ? "&seq=lt." + before : "")),
        out = new JSONArray();
    for (int i = rows.length() - 1; i >= 0; i--) {
      JSONObject row = rows.getJSONObject(i);
      row.put(
          "body",
          new JSONObject(
              team.decryptText(
                  row.getString("encrypted_body"), "chat-message-v1|" + row.getString("id"))));
      out.put(row);
    }
    return out;
  }

  JSONObject messageTicket(JSONObject body, String kind, String parent) throws Exception {
    String id = UUID.randomUUID().toString();
    return obj(
        "id",
        id,
        "owner",
        userId,
        "kind",
        kind,
        "parent",
        parent,
        "encrypted",
        team.seal(body.toString(), "chat-message-v1|" + id));
  }

  void send(JSONObject ticket) throws Exception {
    checkAccess(false);
    if (!userId.equals(ticket.getString("owner"))) throw new Exception("Mensaje de otra cuenta.");
    JSONObject row =
        (JSONObject)
            rpc(
                "mega_chat_send",
                obj(
                    "p_id",
                    ticket.getString("id"),
                    "p_kind",
                    ticket.getString("kind"),
                    "p_body",
                    ticket.getString("encrypted"),
                    "p_parent",
                    ticket.opt("parent"),
                    "p_mentions",
                    new JSONArray()));
    if (!ticket.getString("id").equals(row.getString("id"))
        || !ticket.getString("encrypted").equals(row.getString("encrypted_body")))
      throw new Exception("El mensaje no se confirmó. Reintenta el mismo envío.");
  }

  byte[] chatImage(JSONObject message) throws Exception {
    checkAccess(false);
    String id = message.getString("id"), author = message.getString("created_by");
    UUID.fromString(id);
    UUID.fromString(author);
    byte[] cipher =
        exchange(
            "/storage/v1/object/authenticated/mega-chat-images/"
                + workspace
                + "/"
                + author
                + "/"
                + id
                + "/image.bin",
            "GET",
            null,
            false,
            true);
    if (cipher.length > 163904) throw new Exception("Imagen demasiado grande.");
    try {
      return team.decrypt(cipher, "chat-image-v1|" + id);
    } finally {
      Arrays.fill(cipher, (byte) 0);
    }
  }
}
