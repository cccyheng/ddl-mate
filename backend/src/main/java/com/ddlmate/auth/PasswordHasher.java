package com.ddlmate.auth;

import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.SecureRandom;
import java.security.spec.InvalidKeySpecException;
import java.util.Base64;

import javax.crypto.SecretKeyFactory;
import javax.crypto.spec.PBEKeySpec;

/**
 * 密码哈希：PBKDF2-HmacSHA256，格式 {@code pbkdf2$<迭代次数>$<盐 base64>$<哈希 base64>}。
 *
 * <p>只用 JDK 自带算法，不引入额外依赖。生成哈希：
 * {@code node scripts/hash-password.mjs}（与这里同一算法与参数）。</p>
 */
public final class PasswordHasher {

    public static final int DEFAULT_ITERATIONS = 210_000;
    private static final int KEY_BITS = 256;

    private PasswordHasher() {
    }

    public static String hash(char[] password) {
        byte[] salt = new byte[16];
        new SecureRandom().nextBytes(salt);
        byte[] key = derive(password, salt, DEFAULT_ITERATIONS);
        return "pbkdf2$" + DEFAULT_ITERATIONS + "$" + Base64.getEncoder().encodeToString(salt) + "$"
                + Base64.getEncoder().encodeToString(key);
    }

    /** 恒定时间比较；格式不对一律返回 false。 */
    public static boolean matches(char[] password, String encoded) {
        if (password == null || encoded == null) {
            return false;
        }
        String[] parts = encoded.split("\\$");
        if (parts.length != 4 || !"pbkdf2".equals(parts[0])) {
            return false;
        }
        try {
            int iterations = Integer.parseInt(parts[1]);
            if (iterations < 10_000 || iterations > 10_000_000) {
                return false;
            }
            byte[] salt = Base64.getDecoder().decode(parts[2]);
            byte[] expected = Base64.getDecoder().decode(parts[3]);
            return MessageDigest.isEqual(expected, derive(password, salt, iterations));
        } catch (IllegalArgumentException ex) {
            return false;
        }
    }

    public static boolean isWellFormed(String encoded) {
        return encoded != null && encoded.matches("^pbkdf2\\$\\d+\\$[A-Za-z0-9+/=]+\\$[A-Za-z0-9+/=]+$");
    }

    private static byte[] derive(char[] password, byte[] salt, int iterations) {
        try {
            PBEKeySpec spec = new PBEKeySpec(password, salt, iterations, KEY_BITS);
            return SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256").generateSecret(spec).getEncoded();
        } catch (NoSuchAlgorithmException | InvalidKeySpecException ex) {
            throw new IllegalStateException("PBKDF2 不可用", ex);
        }
    }
}
