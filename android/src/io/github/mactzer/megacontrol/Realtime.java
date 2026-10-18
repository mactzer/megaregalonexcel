package io.github.mactzer.megacontrol;

import java.net.URI;
import java.net.URLEncoder;
import java.util.Arrays;
import java.util.List;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import javax.net.ssl.SSLParameters;
import org.java_websocket.client.WebSocketClient;
import org.java_websocket.handshake.ServerHandshake;
import org.json.JSONArray;
import org.json.JSONObject;

/** One authenticated Phoenix channel. Paused with the activity; REST checks stay authoritative. */
final class Realtime {
  interface Token {
    String get() throws Exception;
  }

  interface Events {
    void changed(String table);

    void status(boolean live);
  }

  final List<String> tables =
      Arrays.asList(
          "mega_audit_records",
          "mega_product_queries",
          "mega_product_prices",
          "mega_chat_messages",
          "mega_chat_cases",
          "mega_chat_products");
  final String url, key, workspace, topic;
  final Token token;
  final Events events;
  final ScheduledExecutorService timer = Executors.newSingleThreadScheduledExecutor();
  volatile boolean stopped, joined;
  volatile WebSocketClient socket;
  volatile long lastReply;
  long ref;
  int retries;
  boolean reconnectQueued;

  Realtime(String url, String key, String workspace, Token token, Events events) {
    this.url = url;
    this.key = key;
    this.workspace = workspace;
    this.token = token;
    this.events = events;
    topic = "realtime:mega-native-" + workspace;
    timer.execute(() -> connect());
    timer.scheduleAtFixedRate(
        () -> {
          if (stopped || socket == null || !socket.isOpen()) return;
          if (System.currentTimeMillis() - lastReply > 65000) {
            reconnect();
            return;
          }
          try {
            send("heartbeat", new JSONObject(), "phoenix");
            send("access_token", NativeApi.obj("access_token", token.get()), topic);
          } catch (Exception e) {
            reconnect();
          }
        },
        25,
        25,
        TimeUnit.SECONDS);
  }

  synchronized void send(String event, JSONObject payload, String channel) throws Exception {
    WebSocketClient s = socket;
    if (s != null && s.isOpen())
      s.send(
          NativeApi.obj(
                  "topic",
                  channel,
                  "event",
                  event,
                  "payload",
                  payload,
                  "ref",
                  String.valueOf(++ref))
              .toString());
  }

  void connect() {
    if (stopped) return;
    joined = false;
    try {
      String access = token.get();
      if (stopped) return;
      URI uri =
          new URI(
              url.replaceFirst("^https:", "wss:")
                  + "/realtime/v1/websocket?apikey="
                  + URLEncoder.encode(key, "UTF-8")
                  + "&vsn=1.0.0");
      WebSocketClient next =
          new WebSocketClient(uri) {
            @Override
            protected void onSetSSLParameters(SSLParameters p) {
              p.setEndpointIdentificationAlgorithm("HTTPS");
            }

            @Override
            public void onOpen(ServerHandshake h) {
              if (stopped || socket != this) {
                close();
                return;
              }
              try {
                JSONArray changes = new JSONArray();
                for (String table : tables)
                  changes.put(
                      NativeApi.obj(
                          "event",
                          "*",
                          "schema",
                          "public",
                          "table",
                          table,
                          "filter",
                          "workspace_id=eq." + workspace));
                Realtime.this.send(
                    "phx_join",
                    NativeApi.obj(
                        "config",
                        NativeApi.obj(
                            "broadcast",
                            NativeApi.obj("self", false),
                            "presence",
                            NativeApi.obj("key", ""),
                            "postgres_changes",
                            changes),
                        "access_token",
                        access),
                    topic);
                lastReply = System.currentTimeMillis();
                timer.schedule(
                    () -> {
                      if (!stopped && socket == this && !joined) Realtime.this.reconnect();
                    },
                    12,
                    TimeUnit.SECONDS);
              } catch (Exception e) {
                Realtime.this.reconnect();
              }
            }

            @Override
            public void onMessage(String raw) {
              if (stopped || socket != this) return;
              try {
                JSONObject m = new JSONObject(raw);
                String event = m.optString("event"), channel = m.optString("topic");
                if (channel.equals("phoenix") && event.equals("phx_reply")) {
                  lastReply = System.currentTimeMillis();
                  return;
                }
                if (!channel.equals(topic)) return;
                JSONObject payload = m.optJSONObject("payload");
                if (payload == null) return;
                if (event.equals("phx_reply")) {
                  if (payload.optString("status").equals("ok")
                      && payload.optJSONObject("response") != null
                      && payload.getJSONObject("response").optJSONArray("postgres_changes")
                          != null) {
                    if (payload.getJSONObject("response").getJSONArray("postgres_changes").length()
                        != tables.size()) {
                      Realtime.this.reconnect();
                      return;
                    }
                    joined = true;
                    retries = 0;
                    lastReply = System.currentTimeMillis();
                    events.status(true);
                    events.changed("all");
                  } else if (payload.optString("status").equals("error")) Realtime.this.reconnect();
                } else if (event.equals("phx_error") || event.equals("phx_close"))
                  Realtime.this.reconnect();
                else if (event.equals("postgres_changes")) {
                  JSONObject data = payload.optJSONObject("data");
                  if (data != null
                      && data.optString("schema").equals("public")
                      && tables.contains(data.optString("table"))) {
                    JSONObject row = data.optJSONObject("record");
                    if (row != null && workspace.equals(row.optString("workspace_id")))
                      events.changed(data.getString("table"));
                  }
                }
              } catch (Exception ignored) {
              }
            }

            @Override
            public void onClose(int code, String reason, boolean remote) {
              if (socket == this && !stopped) Realtime.this.reconnect();
            }

            @Override
            public void onError(Exception e) {
              if (!stopped) events.status(false);
            }
          };
      socket = next;
      next.setConnectionLostTimeout(45);
      next.connect();
    } catch (Exception e) {
      reconnect();
    }
  }

  synchronized void reconnect() {
    if (stopped || reconnectQueued) return;
    events.status(false);
    WebSocketClient old = socket;
    socket = null;
    if (old != null) old.close();
    reconnectQueued = true;
    long delay = Math.min(30, 1L << Math.min(retries++, 5));
    timer.schedule(
        () -> {
          reconnectQueued = false;
          connect();
        },
        delay,
        TimeUnit.SECONDS);
  }

  void close() {
    stopped = true;
    timer.shutdownNow();
    WebSocketClient s = socket;
    socket = null;
    if (s != null) s.close();
  }
}
