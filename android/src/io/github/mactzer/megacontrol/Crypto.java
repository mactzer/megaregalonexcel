package io.github.mactzer.megacontrol;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.Arrays;
import java.util.Base64;
import java.util.Locale;
import javax.crypto.Cipher;
import javax.crypto.Mac;
import javax.crypto.SecretKeyFactory;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.PBEKeySpec;
import javax.crypto.spec.SecretKeySpec;

/** Wire-compatible implementation of audit-crypto.js, independent of Android UI. */
final class Crypto {
  static byte[] utf8(String s) {
    return s.getBytes(StandardCharsets.UTF_8);
  }

  static byte[] hmac(byte[] key, byte[] input) throws Exception {
    Mac mac = Mac.getInstance("HmacSHA256");
    mac.init(new SecretKeySpec(key, "HmacSHA256"));
    return mac.doFinal(input);
  }

  static byte[] hkdf(byte[] input, String workspace, String info) throws Exception {
    byte[] prk = hmac(utf8(workspace), input),
        data = utf8(info),
        block = Arrays.copyOf(data, data.length + 1);
    block[block.length - 1] = 1;
    try {
      return hmac(prk, block);
    } finally {
      Arrays.fill(prk, (byte) 0);
      Arrays.fill(block, (byte) 0);
    }
  }

  static String hex(byte[] b) {
    StringBuilder s = new StringBuilder();
    for (byte x : b) s.append(String.format(Locale.ROOT, "%02x", x & 255));
    return s.toString();
  }

  static byte[] decode(String s) {
    return Base64.getDecoder().decode(s);
  }

  static String base64(byte[] b) {
    return Base64.getEncoder().encodeToString(b);
  }

  static byte[] envelope(byte[] key, byte[] data, String aad, boolean encrypt) throws Exception {
    Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
    if (encrypt) {
      byte[] iv = new byte[12];
      new SecureRandom().nextBytes(iv);
      c.init(Cipher.ENCRYPT_MODE, new SecretKeySpec(key, "AES"), new GCMParameterSpec(128, iv));
      c.updateAAD(utf8(aad));
      byte[] body = c.doFinal(data), out = new byte[13 + body.length];
      out[0] = 1;
      System.arraycopy(iv, 0, out, 1, 12);
      System.arraycopy(body, 0, out, 13, body.length);
      return out;
    }
    if (data.length < 29 || data[0] != 1)
      throw new Exception("Documento cifrado incompleto o incompatible.");
    c.init(
        Cipher.DECRYPT_MODE,
        new SecretKeySpec(key, "AES"),
        new GCMParameterSpec(128, Arrays.copyOfRange(data, 1, 13)));
    c.updateAAD(utf8(aad));
    return c.doFinal(data, 13, data.length - 13);
  }

  static final class Account {
    final String workspace, username, authPassword;
    private final byte[] wrap;

    Account(String raw, char[] password, String workspace) throws Exception {
      username = raw.trim().toLowerCase(Locale.ROOT);
      this.workspace = workspace;
      if (!username.matches("[a-z0-9][a-z0-9._-]{1,30}[a-z0-9]") || username.contains(".."))
        throw new Exception("Revisa el usuario de MegaControl.");
      if (password.length < 12 || password.length > 1024)
        throw new Exception("La contraseña debe tener entre 12 y 1024 caracteres.");
      PBEKeySpec spec =
          new PBEKeySpec(
              password, utf8("mega-audit:user:v1|" + workspace + "|" + username), 600000, 256);
      byte[] material;
      try {
        material =
            SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256").generateSecret(spec).getEncoded();
      } finally {
        spec.clearPassword();
        Arrays.fill(password, '\0');
      }
      try {
        byte[] auth = hkdf(material, workspace, "mega-audit:user-auth:v1");
        try {
          authPassword = Base64.getUrlEncoder().withoutPadding().encodeToString(auth);
        } finally {
          Arrays.fill(auth, (byte) 0);
        }
        wrap = hkdf(material, workspace, "mega-audit:user-wrap:v1");
      } finally {
        Arrays.fill(material, (byte) 0);
      }
    }

    Team unlock(String wrapped) throws Exception {
      byte[] secret =
          envelope(
              wrap, decode(wrapped), "mega-audit:user-key:v1|" + workspace + "|" + username, false);
      try {
        if (secret.length != 32) throw new Exception("La clave del equipo no es válida.");
        return new Team(secret, workspace);
      } finally {
        Arrays.fill(secret, (byte) 0);
      }
    }

    void clear() {
      Arrays.fill(wrap, (byte) 0);
    }
  }

  static final class Team {
    final String workspace, fingerprint;
    private final byte[] aes, index;

    Team(byte[] secret, String workspace) throws Exception {
      this.workspace = workspace;
      aes = hkdf(secret, workspace, "megaregalonexcel/audit/aes-gcm/v1");
      index = hkdf(secret, workspace, "megaregalonexcel/audit/hmac/v1");
      byte[] fp = hkdf(secret, workspace, "megaregalonexcel/audit/fingerprint/v1");
      try {
        fingerprint = hex(MessageDigest.getInstance("SHA-256").digest(fp));
      } finally {
        Arrays.fill(fp, (byte) 0);
      }
    }

    byte[] decrypt(byte[] encrypted, String context) throws Exception {
      return envelope(aes, encrypted, workspace + "|" + context, false);
    }

    String decryptText(String encrypted, String context) throws Exception {
      byte[] plain = decrypt(decode(encrypted), context);
      try {
        return new String(plain, StandardCharsets.UTF_8);
      } finally {
        Arrays.fill(plain, (byte) 0);
      }
    }

    byte[] encrypt(byte[] data, String context) throws Exception {
      return envelope(aes, data, workspace + "|" + context, true);
    }

    String seal(String text, String context) throws Exception {
      byte[] plain = utf8(text);
      try {
        return base64(encrypt(plain, context));
      } finally {
        Arrays.fill(plain, (byte) 0);
      }
    }

    String tag(String value) throws Exception {
      return hex(hmac(index, utf8("megaregalonexcel/catalog/product/v1|" + value)));
    }

    String salidaTag(String number) throws Exception {
      return hex(hmac(index, utf8("megaregalonexcel/audit/salida/v1|" + number)));
    }

    void clear() {
      Arrays.fill(aes, (byte) 0);
      Arrays.fill(index, (byte) 0);
    }
  }
}
