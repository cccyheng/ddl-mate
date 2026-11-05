package com.ddlmate.auth;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

class PasswordHasherTest {

    /** 由 scripts/hash-password.mjs 同一算法（Node crypto.pbkdf2Sync）生成，确保两边一致。 */
    private static final String FROM_NODE =
            "pbkdf2$210000$MDEyMzQ1Njc4OWFiY2RlZg==$BuXtBiZy/hSDQOIlobNvImPkwlSxEP1n6h5Fme5lFQQ=";

    @Test
    @DisplayName("Node 脚本生成的哈希能被后端校验（含中文密码）")
    void nodeHashCompatible() {
        assertThat(PasswordHasher.matches("密码Test-123".toCharArray(), FROM_NODE)).isTrue();
        assertThat(PasswordHasher.matches("密码Test-124".toCharArray(), FROM_NODE)).isFalse();
    }

    @Test
    @DisplayName("自己生成的哈希可校验；格式不对一律不通过")
    void roundTripAndMalformed() {
        String hash = PasswordHasher.hash("abc".toCharArray());
        assertThat(PasswordHasher.isWellFormed(hash)).isTrue();
        assertThat(PasswordHasher.matches("abc".toCharArray(), hash)).isTrue();
        assertThat(PasswordHasher.matches("abc".toCharArray(), "plain-text")).isFalse();
        assertThat(PasswordHasher.matches("abc".toCharArray(), "pbkdf2$1$AA==$AA==")).isFalse();
        assertThat(PasswordHasher.matches(null, hash)).isFalse();
    }
}
