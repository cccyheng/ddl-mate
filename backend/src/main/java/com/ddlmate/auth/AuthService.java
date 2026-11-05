package com.ddlmate.auth;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Clock;
import java.time.Instant;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicBoolean;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import jakarta.annotation.PostConstruct;

/**
 * 校验账号密码 + 失败锁定 + 一次性设置密码。
 *
 * <p>密码来源：网页上设置过的（{@link AuthCredential}，存库）优先；没有时用环境变量里的 PBKDF2 哈希。</p>
 *
 * <p>锁定按来源 IP 计数：连续失败（登录或设置码）达到上限后，这个 IP 在锁定期内的任何尝试都直接拒绝
 * （包括正确密码），防止在公网上被暴力猜测。</p>
 */
@Service
public class AuthService {

    public static final int MIN_PASSWORD_LENGTH = 10;
    private static final int MIN_SETUP_TOKEN_LENGTH = 24;

    private static final Logger log = LoggerFactory.getLogger(AuthService.class);

    private final AuthProperties properties;
    private final AuthCredentialRepository credentials;
    private final Clock clock = Clock.systemUTC();
    private final ConcurrentHashMap<String, Attempts> attempts = new ConcurrentHashMap<>();
    /** 设置码只能用一次：用过后即使环境变量还在也不再接受（重启前）。 */
    private final AtomicBoolean setupUsed = new AtomicBoolean(false);

    public AuthService(AuthProperties properties, AuthCredentialRepository credentials) {
        this.properties = properties;
        this.credentials = credentials;
    }

    @PostConstruct
    void checkConfiguration() {
        if (!properties.enabled()) {
            log.warn("登录未启用：只适合在本机 127.0.0.1 使用，不要直接暴露到公网");
            return;
        }
        if (properties.username() == null || properties.username().isBlank()) {
            throw new IllegalStateException("已启用登录，但没有配置 DDLMATE_AUTH_USERNAME，拒绝启动");
        }
        boolean hasEnvHash = PasswordHasher.isWellFormed(properties.passwordHash());
        boolean hasStored = credentials.existsById(properties.username());
        if (!hasEnvHash && !hasStored && !setupAvailable()) {
            throw new IllegalStateException("已启用登录，但没有可用的密码：请配置 DDLMATE_AUTH_PASSWORD_HASH，"
                    + "或配置一次性设置码 DDLMATE_AUTH_SETUP_TOKEN（至少 " + MIN_SETUP_TOKEN_LENGTH + " 位）后在网页上设置");
        }
        log.info("登录已启用：用户名 {}（密码来源：{}）{}", properties.username(),
                hasStored ? "网页设置" : hasEnvHash ? "环境变量" : "尚未设置",
                setupAvailable() ? "；一次性设置密码已开放，用完请删除 DDLMATE_AUTH_SETUP_TOKEN" : "");
    }

    public boolean enabled() {
        return properties.enabled();
    }

    public String username() {
        return properties.username();
    }

    /** 配置了足够长的设置码、且本次运行还没用过。 */
    public boolean setupAvailable() {
        String token = properties.setupToken();
        return properties.enabled() && token != null && token.length() >= MIN_SETUP_TOKEN_LENGTH && !setupUsed.get();
    }

    public sealed interface Result permits Ok, Rejected, Locked {
    }

    public record Ok() implements Result {
    }

    public record Rejected() implements Result {
    }

    public record Locked(long retryAfterSeconds) implements Result {
    }

    public Result authenticate(String clientKey, String username, String password) {
        return guarded(clientKey, () -> properties.username().equals(username)
                && PasswordHasher.matches(password == null ? null : password.toCharArray(), currentHash()));
    }

    /**
     * 用一次性设置码设置密码。设置码错误按失败计数（同样会锁定）；成功后设置码作废。
     * 密码长度在调用前已校验。
     */
    @Transactional
    public Result setupPassword(String clientKey, String token, String newPassword) {
        Result result = guarded(clientKey, () -> setupAvailable() && constantTimeEquals(token, properties.setupToken()));
        if (result instanceof Ok) {
            if (!setupUsed.compareAndSet(false, true)) {
                return new Rejected();
            }
            String hash = PasswordHasher.hash(newPassword.toCharArray());
            AuthCredential credential = credentials.findById(properties.username())
                    .orElseGet(() -> new AuthCredential(properties.username(), hash));
            credential.setPasswordHash(hash);
            credentials.save(credential);
            log.warn("已通过一次性设置码设置登录密码（用户 {}），请从配置里删除 DDLMATE_AUTH_SETUP_TOKEN", properties.username());
        }
        return result;
    }

    private String currentHash() {
        return credentials.findById(properties.username())
                .map(AuthCredential::getPasswordHash)
                .orElse(properties.passwordHash());
    }

    private interface Check {
        boolean passes();
    }

    private Result guarded(String clientKey, Check check) {
        Instant now = clock.instant();
        Attempts state = attempts.computeIfAbsent(clientKey, k -> new Attempts());
        synchronized (state) {
            if (state.lockedUntil != null && now.isBefore(state.lockedUntil)) {
                return new Locked(state.lockedUntil.getEpochSecond() - now.getEpochSecond() + 1);
            }
            if (check.passes()) {
                attempts.remove(clientKey);
                return new Ok();
            }
            state.failures++;
            if (state.failures >= properties.maxFailuresOrDefault()) {
                state.failures = 0;
                state.lockedUntil = now.plusSeconds(properties.lockSecondsOrDefault());
                log.warn("连续失败，来源 {} 锁定 {} 秒", clientKey, properties.lockSecondsOrDefault());
                return new Locked(properties.lockSecondsOrDefault());
            }
            return new Rejected();
        }
    }

    private static boolean constantTimeEquals(String a, String b) {
        if (a == null || b == null) {
            return false;
        }
        return MessageDigest.isEqual(a.getBytes(StandardCharsets.UTF_8), b.getBytes(StandardCharsets.UTF_8));
    }

    private static final class Attempts {
        int failures;
        Instant lockedUntil;
    }
}
