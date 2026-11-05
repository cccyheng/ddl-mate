package com.ddlmate.auth;

import org.springframework.boot.context.properties.ConfigurationProperties;

/**
 * 登录与注册配置（{@code ddlmate.auth.*}）。
 *
 * @param enabled             是否启用登录。默认关闭：本机 127.0.0.1 使用与测试保持原样；部署到公网必须开启
 * @param username            站长账号的用户名（第一次启动时，已有数据都归到这个账号）
 * @param passwordHash        站长的初始 PBKDF2 哈希（可选；网页上设置过密码后不再使用）
 * @param maxFailures         连续失败多少次后暂时锁定
 * @param lockSeconds         锁定时长（秒）
 * @param setupToken          一次性设置码：配置后可在 /setup 页面凭它设置站长密码；用完立即删掉
 * @param registrationEnabled 是否开放注册
 * @param registrationsPerIpPerHour 同一来源每小时最多注册几个账号
 * @param registrationsPerDay 全站每天最多注册几个账号
 */
@ConfigurationProperties(prefix = "ddlmate.auth")
public record AuthProperties(boolean enabled, String username, String passwordHash, Integer maxFailures,
        Integer lockSeconds, String setupToken, boolean registrationEnabled, Integer registrationsPerIpPerHour,
        Integer registrationsPerDay) {

    public int maxFailuresOrDefault() {
        return maxFailures == null || maxFailures < 1 ? 5 : maxFailures;
    }

    public int lockSecondsOrDefault() {
        return lockSeconds == null || lockSeconds < 1 ? 300 : lockSeconds;
    }

    public int registrationsPerIpPerHourOrDefault() {
        return registrationsPerIpPerHour == null || registrationsPerIpPerHour < 1 ? 3 : registrationsPerIpPerHour;
    }

    public int registrationsPerDayOrDefault() {
        return registrationsPerDay == null || registrationsPerDay < 1 ? 30 : registrationsPerDay;
    }
}
