package com.ddlmate.auth;

import org.springframework.boot.context.properties.ConfigurationProperties;

/**
 * 单人登录配置（{@code ddlmate.auth.*}）。
 *
 * @param enabled      是否启用登录。默认关闭：本机 127.0.0.1 使用与测试保持原样；部署到公网必须开启
 * @param username     登录用户名
 * @param passwordHash PBKDF2 哈希（见 {@link PasswordHasher}），绝不配置明文密码
 * @param maxFailures  连续失败多少次后暂时锁定
 * @param lockSeconds  锁定时长（秒）
 * @param setupToken   一次性设置码：配置后可在 /setup 页面凭它设置（或重设）密码；用完立即删掉
 */
@ConfigurationProperties(prefix = "ddlmate.auth")
public record AuthProperties(boolean enabled, String username, String passwordHash, Integer maxFailures,
        Integer lockSeconds, String setupToken) {

    public int maxFailuresOrDefault() {
        return maxFailures == null || maxFailures < 1 ? 5 : maxFailures;
    }

    public int lockSecondsOrDefault() {
        return lockSeconds == null || lockSeconds < 1 ? 300 : lockSeconds;
    }
}
