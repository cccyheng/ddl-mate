package com.ddlmate.auth;

import java.time.Clock;
import java.time.Instant;
import java.util.concurrent.ConcurrentHashMap;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import jakarta.annotation.PostConstruct;

/**
 * 校验账号密码 + 失败锁定。
 *
 * <p>锁定按来源 IP 计数：连续失败达到上限后，这个 IP 在锁定期内的任何登录都直接拒绝（包括正确密码），
 * 防止在公网上被暴力猜密码。</p>
 */
@Service
public class AuthService {

    private static final Logger log = LoggerFactory.getLogger(AuthService.class);

    private final AuthProperties properties;
    private final Clock clock = Clock.systemUTC();
    private final ConcurrentHashMap<String, Attempts> attempts = new ConcurrentHashMap<>();

    public AuthService(AuthProperties properties) {
        this.properties = properties;
    }

    @PostConstruct
    void checkConfiguration() {
        if (!properties.enabled()) {
            log.warn("登录未启用：只适合在本机 127.0.0.1 使用，不要直接暴露到公网");
            return;
        }
        if (properties.username() == null || properties.username().isBlank()
                || !PasswordHasher.isWellFormed(properties.passwordHash())) {
            throw new IllegalStateException(
                    "已启用登录，但没有配置 DDLMATE_AUTH_USERNAME / DDLMATE_AUTH_PASSWORD_HASH（PBKDF2 格式），拒绝启动");
        }
        log.info("登录已启用：用户名 {}", properties.username());
    }

    public boolean enabled() {
        return properties.enabled();
    }

    public String username() {
        return properties.username();
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
        Instant now = clock.instant();
        Attempts state = attempts.computeIfAbsent(clientKey, k -> new Attempts());
        synchronized (state) {
            if (state.lockedUntil != null && now.isBefore(state.lockedUntil)) {
                return new Locked(state.lockedUntil.getEpochSecond() - now.getEpochSecond() + 1);
            }
            boolean userOk = properties.username().equals(username);
            boolean passwordOk = PasswordHasher.matches(password == null ? null : password.toCharArray(),
                    properties.passwordHash());
            if (userOk && passwordOk) {
                attempts.remove(clientKey);
                return new Ok();
            }
            state.failures++;
            if (state.failures >= properties.maxFailuresOrDefault()) {
                state.failures = 0;
                state.lockedUntil = now.plusSeconds(properties.lockSecondsOrDefault());
                log.warn("登录连续失败，来源 {} 锁定 {} 秒", clientKey, properties.lockSecondsOrDefault());
                return new Locked(properties.lockSecondsOrDefault());
            }
            return new Rejected();
        }
    }

    private static final class Attempts {
        int failures;
        Instant lockedUntil;
    }
}
