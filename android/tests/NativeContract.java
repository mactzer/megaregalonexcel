package io.github.mactzer.megacontrol;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.file.Files;
import java.nio.file.Paths;
import java.util.Arrays;
import java.util.HashMap;
import java.util.Map;

/** Fictional local protocol contract. It never connects to real Supabase or users. */
public final class NativeContract {
    static void eq(Object a,Object b,String message)throws Exception{if(!java.util.Objects.equals(a,b))throw new Exception(message+": "+a+" != "+b);}
    static void yes(boolean a,String message)throws Exception{if(!a)throw new Exception(message);}
    static JSONObject fixture;static int assertions;
    static void check(boolean condition,String name)throws Exception{yes(condition,name);assertions++;}
    static final class Fake implements NativeApi.Transport {
        JSONObject price;boolean loseAck,missing,userRole;int priceWrites,preparedRequests;String lastPriceCipher;
        final String user="11111111-1111-4111-8111-111111111111";
        final Map<String,String> queries=new HashMap<>();
        @Override public HttpURLConnection open(URL url){return new HttpURLConnection(url){
            ByteArrayOutputStream sent=new ByteArrayOutputStream();byte[] response;int status=200;
            public void disconnect(){}public boolean usingProxy(){return false;}public void connect(){}public OutputStream getOutputStream(){return sent;}
            @Override public int getResponseCode()throws java.io.IOException{try{String path=url.getPath(),q=url.getQuery();JSONObject body=sent.size()==0?new JSONObject():new JSONObject(sent.toString("UTF-8"));Object data;
                if(path.equals("/auth/v1/token")){eq(body.getString("password"),fixture.getString("authPassword"),"credencial derivada");data=NativeApi.obj("access_token","fictional-access","refresh_token","fictional-refresh","expires_in",3600,"user",NativeApi.obj("id",user,"email","ficticio@usuarios.megaregalonexcel.invalid"));}
                else if(path.endsWith("/mega_audit_members"))data=new JSONArray().put(NativeApi.obj("role",userRole?"user":"admin"));
                else if(path.endsWith("/mega_audit_workspace"))data=new JSONArray().put(NativeApi.obj("key_fingerprint",fixture.getString("fingerprint")));
                else if(path.endsWith("/mega_audit_user_keys"))data=new JSONArray().put(NativeApi.obj("wrapped_key",fixture.getString("wrapped")));
                else if(path.endsWith("/mega_audit_catalog_records")){preparedRequests++;data=fixture.getJSONArray("sources");}
                else if(path.endsWith("/mega_product_catalog")){data=fixture.getJSONArray("shared");if(missing)data=new JSONArray().put(((JSONArray)data).getJSONObject(0));}
                else if(path.endsWith("/mega_chat_products"))data=new JSONArray();
                else if(path.endsWith("/mega_product_prices"))data=price==null?new JSONArray():new JSONArray().put(price);
                else if(path.endsWith("/mega_product_price_set")){
                    String cipher=body.getString("p_encrypted_price");long expected=body.getLong("p_expected_version");
                    if(price!=null&&price.getLong("version")==expected+1&&cipher.equals(price.getString("encrypted_price")))data=price;
                    else if(price!=null&&expected!=price.getLong("version")){status=409;data=NativeApi.obj("code","40001");}
                    else{priceWrites++;lastPriceCipher=cipher;price=NativeApi.obj("workspace_id",fixture.getString("workspace"),"product_tag",body.getString("p_product_tag"),"version",expected+1,"updated_by",user,"updated_at","2026-10-18T20:00:00Z","encrypted_price",cipher);data=price;}
                    if(loseAck){loseAck=false;throw new java.io.IOException("Respuesta ficticia perdida después del guardado");}
                }
                else if(path.endsWith("/mega_product_query_add")){String id=body.getString("p_id"),cipher=body.getString("p_encrypted_query");if(queries.containsKey(id)&&!queries.get(id).equals(cipher))throw new Exception("UUID reutilizado con otro contenido");queries.put(id,cipher);data=NativeApi.obj("id",id,"created_by",user,"encrypted_query",cipher);}
                else if(path.endsWith("/mega_product_queries")){JSONArray rows=new JSONArray();for(Map.Entry<String,String> e:queries.entrySet())rows.put(NativeApi.obj("workspace_id",fixture.getString("workspace"),"id",e.getKey(),"created_by",user,"created_at","2026-10-18T20:00:00Z","encrypted_query",e.getValue()));data=rows;}
                else if(path.endsWith("/mega_audit_authors"))data=new JSONArray().put(NativeApi.obj("user_id",user,"username","ficticio"));
                else if(path.contains("/storage/v1/object/authenticated/")){response=Crypto.decode(fixture.getString("pdfCipher"));return 200;}
                else throw new Exception("Petición inesperada: "+path);
                if(!path.startsWith("/auth/")&&!"Bearer fictional-access".equals(getRequestProperty("Authorization")))throw new Exception("Falta el JWT del usuario");
                response=data.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8);return status;
            }catch(java.io.IOException e){throw e;}catch(Exception e){throw new java.io.IOException(e);}}
            public InputStream getInputStream(){return new ByteArrayInputStream(response);}public InputStream getErrorStream(){return new ByteArrayInputStream(response);}
        };}
    }
    public static void main(String[] args)throws Exception{
        fixture=new JSONObject(new String(Files.readAllBytes(Paths.get(args[0])),java.nio.charset.StandardCharsets.UTF_8));String workspace=fixture.getString("workspace");
        char[] password=fixture.getString("password").toCharArray();Crypto.Account account=new Crypto.Account(" FICTICIO ",password,workspace);eq(account.authPassword,fixture.getString("authPassword"),"PBKDF2 y HKDF");check(new String(password).replace("\0","").isEmpty(),"La copia de contraseña se limpia");Crypto.Team team=account.unlock(fixture.getString("wrapped"));eq(team.fingerprint,fixture.getString("fingerprint"),"huella del equipo");eq(team.tag("0012345678905"),fixture.getString("productTag"),"HMAC de producto conserva ceros");eq(team.decryptText(fixture.getString("metadataCipher"),"record-fictional|metadata"),fixture.getString("metadataPlain"),"AES-GCM web -> Java");
        byte[] bad=Crypto.decode(fixture.getString("metadataCipher"));bad[bad.length-1]^=1;boolean rejected=false;try{team.decrypt(bad,"record-fictional|metadata");}catch(Exception expected){rejected=true;}check(rejected,"Se rechaza un documento alterado");
        JSONObject output=NativeApi.obj("javaCipher",team.seal("Prueba nativa con ceros 00123, precio 7.99 y emoji 📦","interop-native"));
        Fake backend=new Fake();NativeApi client=new NativeApi("https://fixture.invalid","public-fictional",workspace,null,backend);client.login("ficticio",fixture.getString("password").toCharArray());check(client.authenticated(),"Login directo y clave cifrada compatible");check(client.role.equals("admin"),"Permisos del servidor");client.prepare(null);NativeApi.Result r=client.lookup("0012345678905",false);check(r.match!=null,"Producto encontrado");eq(r.match.doc.getString("salida"),"29345","Prioridad por fecha de factura, no ingreso");eq(NativeApi.value(r.match.product,"pventa"),8.99,"Precio de factura más reciente");eq(r.match.product.getString("codigo"),"0012345678905","Código no modificado");
        int prepares=backend.preparedRequests;client.lookup("0012345678905",false);check(prepares==backend.preparedRequests,"El escaneo reutiliza el índice en memoria");
        backend.loseAck=true;boolean lost=false;try{client.setPrice(r.lookupCode,799,0,"Autorizado por el jefe",899L);}catch(Exception expected){lost=true;}check(lost,"Se detecta una confirmación perdida");JSONObject changed=client.setPrice(r.lookupCode,799,0,"Autorizado por el jefe",899L);eq(changed.getLong("cents"),799L,"Precio administrativo");check(backend.priceWrites==1,"Reintento idempotente sin otra versión");
        NativeApi.Result override=client.lookup("0012345678905",false);eq(override.override.getLong("cents"),799L,"Precio editado al consultar");JSONObject ticket=client.queryTicket(override);client.saveQuery(ticket);client.saveQuery(ticket);check(backend.queries.size()==1,"Consulta compartida idempotente");
        JSONObject record=NativeApi.obj("id","22222222-2222-4222-8222-222222222222","created_by",backend.user);check(Arrays.equals(client.document(record,"pdf"),Crypto.decode(fixture.getString("pdfPlain"))),"PDF original descifrado sin alterar bytes");
        backend.userRole=true;boolean denied=false;try{client.setPrice(r.lookupCode,699,1,"No autorizado",799L);}catch(Exception expected){denied=true;}check(denied&&backend.priceWrites==1,"Un usuario sin rol admin no edita precios");
        Fake partial=new Fake();partial.missing=true;NativeApi incomplete=new NativeApi("https://fixture.invalid","public-fictional",workspace,null,partial);incomplete.login("ficticio",fixture.getString("password").toCharArray());incomplete.prepare(null);NativeApi.Result absent=incomplete.lookup("9999999999999",false);check(absent.match==null&&absent.incomplete,"Un índice parcial no confirma ausencia");
        client.clear();check(!client.authenticated()&&client.catalog.isEmpty()&&client.barcodes.isEmpty(),"Logout limpia sesión y productos");
        output.put("assertions",assertions+7);Files.write(Paths.get(args[1]),Crypto.utf8(output.toString()));System.out.println("Contratos nativos verificados: "+(assertions+7));
    }
}
