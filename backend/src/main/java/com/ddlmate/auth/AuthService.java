package com.ddlmate.auth;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayDeque;
import java.util.Deque;
import java.util.Locale;
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.regex.Pattern;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import com.ddlmate.common.InvalidRequestException;
import com.ddlmate.common.TimeZones;
import com.ddlmate.domain.AppUser;
import com.ddlmate.repository.AppUserRepository;

/**
 * 账号：登录校验、失败锁定、注册（含限流）、站长一次性设置密码。
 *
 * <p>锁定按来源 IP 计数：连续失败（登录或设置码）达到上限后，这个 IP 在锁定期内的任何尝试都直接拒绝
 * （包括正确密码），防止在公网上被暴力猜测。</p>
 */
@Service
public class AuthService {

    public static final int MIN_PASSWORD_LENGTH = 10;
    private static final int MIN_SETUP_TOKEN_LENGTH = 24;
    /** 用户名：3–32 位小写字母、数字、下划线、短横线，以字母或数字开头。 */
    public static final Pattern USERNAME = Pattern.compile("^[a-z0-9][a-z0-9_-]{2,31}$");

    private static final Logger log = LoggerFactory.getLogger(AuthService.class);

    private final AuthProperties properties;
    private final AppUserRepository users;
    private final Clock clock = Clock.systemUTC();
    private final ConcurrentHashMap<String, Attempts> attempts = new ConcurrentHashMap<>();
    private final ConcurrentHashMap<String, Deque<Instant>> registrationsByIp = new ConcurrentHashMap<>();
    private final Deque<Instant> registrationsToday = new ArrayDeque<>();
    /** 设置码只能用一次：用过后即使环境变量还在也不再接受（重启前）。 */
    private final AtomicBoolean setupUsed = new AtomicBoolean(false);

    public AuthService(AuthProperties properties, AppUserRepository users) {
        this.properties = properties;
        this.users = users;
    }

    public boolean enabled() {
        return properties.enabled();
    }

    public String adminUsername() {
        return properties.username();
    }

    public boolean registrationEnabled() {
        return properties.enabled() && properties.registrationEnabled();
    }

    /** 配置了足够长的设置码、且本次运行还没用过。 */
    public boolean setupAvailable() {
        String token = properties.setupToken();
        return properties.enabled() && token != null && token.length() >= MIN_SETUP_TOKEN_LENGTH && !setupUsed.get();
    }

    /** 启动检查：站长账号必须能登录（有存库密码 / 环境变量哈希 / 一次性设置码之一）。 */
    public void checkConfiguration() {
        if (!properties.enabled()) {
            log.warn("登录未启用：只适合在本机 127.0.0.1 使用，不要直接暴露到公网");
            return;
        }
        if (properties.username() == null || properties.username().isBlank()) {
            throw new IllegalStateException("已启用登录，但没有配置站长用户名 DDLMATE_AUTH_USERNAME，拒绝启动");
        }
        boolean stored = users.findByUsernameIgnoreCase(properties.username())
                .map(AppUser::getPasswordHash).filter(PasswordHasher::isWellFormed).isPresent();
        boolean envHash = PasswordHasher.isWellFormed(properties.passwordHash());
        if (!stored && !envHash && !setupAvailable()) {
            throw new IllegalStateException("已启用登录，但站长账号没有可用的密码：请配置 DDLMATE_AUTH_PASSWORD_HASH，"
                    + "或一次性设置码 DDLMATE_AUTH_SETUP_TOKEN（至少 " + MIN_SETUP_TOKEN_LENGTH + " 位）后在网页上设置");
        }
        log.info("登录已启用：站长 {}（密码来源：{}）；注册{}{}", properties.username(),
                stored ? "网页设置" : envHash ? "环境变量" : "尚未设置",
                registrationEnabled() ? "已开放" : "未开放",
                setupAvailable() ? "；一次性设置密码已开放，用完请删除 DDLMATE_AUTH_SETUP_TOKEN" : "");
    }

    public sealed interface Result permits Ok, Rejected, Locked, TempExpired {
    }

    /** mustChangePassword：用临时密码登录，必须先改密码。 */
    public record Ok(long userId, String username, boolean mustChangePassword) implements Result {
        public Ok(long userId, String username) {
            this(userId, username, false);
        }
    }

    /** 临时密码已过期。 */
    public record TempExpired() implements Result {
    }

    public record Rejected() implements Result {
    }

    public record Locked(long retryAfterSeconds) implements Result {
    }

    @Transactional(readOnly = true)
    public Result authenticate(String clientKey, String username, String password) {
        String name = normalize(username);
        Optional<AppUser> user = users.findByUsernameIgnoreCase(name);
        Result result = guarded(clientKey,
                () -> user.filter(u -> PasswordHasher.matches(chars(password), hashOf(u))).isPresent(),
                () -> new Ok(user.get().getId(), user.get().getUsername(), user.get().isMustChangePassword()));
        if (result instanceof Ok ok && ok.mustChangePassword()) {
            var expires = user.get().getTempPasswordExpiresAt();
            if (expires != null && expires.isBefore(TimeZones.now())) {
                return new TempExpired();
            }
        }
        return result;
    }

    /**
     * 核对某个账号的当前密码（修改密码、注销账号前用），失败计入同一套锁定规则。
     */
    @Transactional(readOnly = true)
    public Result verifyPassword(String clientKey, long userId, String password) {
        Optional<AppUser> user = users.findById(userId);
        return guarded(clientKey,
                () -> user.filter(u -> PasswordHasher.matches(chars(password), hashOf(u))).isPresent(),
                () -> new Ok(user.get().getId(), user.get().getUsername(), user.get().isMustChangePassword()));
    }

    /** 修改密码：调用方先用 {@link #verifyPassword} 核对旧密码。清除「必须改密码」标记。 */
    @Transactional
    public void changePassword(long userId, String newPassword) {
        if (newPassword == null || newPassword.length() < MIN_PASSWORD_LENGTH) {
            throw new InvalidRequestException("newPassword", "新密码至少 " + MIN_PASSWORD_LENGTH + " 位");
        }
        if (newPassword.length() > 256) {
            throw new InvalidRequestException("newPassword", "新密码太长");
        }
        AppUser user = users.findById(userId).orElseThrow(() -> new InvalidRequestException("账号不存在"));
        if (PasswordHasher.matches(newPassword.toCharArray(), hashOf(user))) {
            throw new InvalidRequestException("newPassword", "新密码不能和原密码相同");
        }
        user.setPasswordHash(PasswordHasher.hash(newPassword.toCharArray()));
        user.setMustChangePassword(false);
        user.setTempPasswordExpiresAt(null);
        users.save(user);
        log.info("用户 {} 修改了密码", user.getUsername());
    }

    private static final String TEMP_ALPHABET = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    private static final java.security.SecureRandom RANDOM = new java.security.SecureRandom();

    /**
     * 站长为忘记密码的用户生成一次性临时密码（24 小时有效，登录后必须改）。
     * 只返回一次给站长，库里只存哈希。
     */
    @Transactional
    public String issueTempPassword(long userId) {
        AppUser user = users.findById(userId).orElseThrow(() -> new InvalidRequestException("账号不存在或已注销"));
        StringBuilder temp = new StringBuilder();
        for (int i = 0; i < 12; i++) {
            if (i > 0 && i % 4 == 0) {
                temp.append('-');
            }
            temp.append(TEMP_ALPHABET.charAt(RANDOM.nextInt(TEMP_ALPHABET.length())));
        }
        user.setPasswordHash(PasswordHasher.hash(temp.toString().toCharArray()));
        user.setMustChangePassword(true);
        user.setTempPasswordExpiresAt(TimeZones.now().plusHours(24));
        users.save(user);
        log.warn("已为用户 {} 生成临时密码（24 小时内有效）", user.getUsername());
        return temp.toString();
    }

    /** 存库的密码优先；站长还没在网页设置过密码时，退回环境变量里的初始哈希。 */
    private String hashOf(AppUser user) {
        if (user.getPasswordHash() != null) {
            return user.getPasswordHash();
        }
        return user.getUsername().equalsIgnoreCase(properties.username()) ? properties.passwordHash() : null;
    }

    /**
     * 站长用一次性设置码设置密码。设置码错误按失败计数（同样会锁定）；成功后设置码作废。
     */
    @Transactional
    public Result setupPassword(String clientKey, String token, String newPassword) {
        Result result = guarded(clientKey,
                () -> setupAvailable() && constantTimeEquals(token, properties.setupToken()),
                () -> new Ok(0, properties.username()));
        if (!(result instanceof Ok)) {
            return result;
        }
        if (!setupUsed.compareAndSet(false, true)) {
            return new Rejected();
        }
        AppUser admin = users.findByUsernameIgnoreCase(properties.username())
                .orElseThrow(() -> new IllegalStateException("站长账号不存在"));
        admin.setPasswordHash(PasswordHasher.hash(newPassword.toCharArray()));
        admin.setRole("ADMIN");
        users.save(admin);
        log.warn("已通过一次性设置码设置站长密码（{}），请从配置里删除 DDLMATE_AUTH_SETUP_TOKEN", admin.getUsername());
        return new Ok(admin.getId(), admin.getUsername());
    }

    /**
     * 注册新账号。限流：同一来源每小时、全站每天各有上限；用户名不区分大小写唯一。
     *
     * @return 新账号
     * @throws InvalidRequestException 用户名不合法 / 已被占用
     * @throws RegistrationLimitException 超过注册频率上限
     */
    @Transactional
    public AppUser register(String clientKey, String username, String password, String displayName) {
        if (!registrationEnabled()) {
            throw new InvalidRequestException("暂未开放注册");
        }
        String name = normalize(username);
        if (!USERNAME.matcher(name).matches()) {
            throw new InvalidRequestException("username", "用户名需为 3–32 位小写字母、数字、下划线或短横线，并以字母或数字开头");
        }
        if (password == null || password.length() < MIN_PASSWORD_LENGTH) {
            throw new InvalidRequestException("password", "密码至少 " + MIN_PASSWORD_LENGTH + " 位");
        }
        reserveRegistrationSlot(clientKey);
        if (users.existsByUsernameIgnoreCase(name)) {
            throw new InvalidRequestException("username", "这个用户名已被使用");
        }
        String shown = displayName == null || displayName.isBlank() ? name : displayName.trim();
        AppUser user = new AppUser(name, shown.length() > 64 ? shown.substring(0, 64) : shown, TimeZones.zone().getId());
        user.setPasswordHash(PasswordHasher.hash(password.toCharArray()));
        user.setRole("USER");
        AppUser saved = users.save(user);
        log.info("新用户注册：{}（id={}，来源 {}）", saved.getUsername(), saved.getId(), clientKey);
        return saved;
    }

    /** 超过注册频率时抛出（HTTP 429）。 */
    public static class RegistrationLimitException extends RuntimeException {
        public RegistrationLimitException(String message) {
            super(message);
        }
    }

    private synchronized void reserveRegistrationSlot(String clientKey) {
        Instant now = clock.instant();
        prune(registrationsToday, now.minus(Duration.ofDays(1)));
        if (registrationsToday.size() >= properties.registrationsPerDayOrDefault()) {
            throw new RegistrationLimitException("今天的注册名额已满，请明天再试");
        }
        Deque<Instant> mine = registrationsByIp.computeIfAbsent(clientKey, k -> new ArrayDeque<>());
        prune(mine, now.minus(Duration.ofHours(1)));
        if (mine.size() >= properties.registrationsPerIpPerHourOrDefault()) {
            throw new RegistrationLimitException("注册太频繁，请一小时后再试");
        }
        mine.addLast(now);
        registrationsToday.addLast(now);
    }

    private static void prune(Deque<Instant> times, Instant before) {
        while (!times.isEmpty() && times.peekFirst().isBefore(before)) {
            times.pollFirst();
        }
    }

    private interface Check {
        boolean passes();
    }

    private Result guarded(String clientKey, Check check, java.util.function.Supplier<Ok> onSuccess) {
        Instant now = clock.instant();
        Attempts state = attempts.computeIfAbsent(clientKey, k -> new Attempts());
        synchronized (state) {
            if (state.lockedUntil != null && now.isBefore(state.lockedUntil)) {
                return new Locked(state.lockedUntil.getEpochSecond() - now.getEpochSecond() + 1);
            }
            if (check.passes()) {
                attempts.remove(clientKey);
                return onSuccess.get();
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

    private static String normalize(String username) {
        return username == null ? "" : username.trim().toLowerCase(Locale.ROOT);
    }

    private static char[] chars(String password) {
        return password == null ? null : password.toCharArray();
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
