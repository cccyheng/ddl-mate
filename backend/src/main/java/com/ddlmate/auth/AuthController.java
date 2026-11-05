package com.ddlmate.auth;

import java.util.LinkedHashMap;
import java.util.Map;

import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import com.ddlmate.common.ApiError;
import com.ddlmate.common.ErrorCodes;
import com.ddlmate.common.ForbiddenException;
import com.ddlmate.domain.AppUser;
import com.ddlmate.service.AccountService;
import com.ddlmate.service.PasswordResetService;
import com.ddlmate.tenant.OwnerResolver;

import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpSession;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;

/** 账号：登录 / 注册 / 退出 / 当前状态 / 站长一次性设置密码。 */
@RestController
@RequestMapping("/api/auth")
public class AuthController {

    private final AuthService authService;
    private final AccountService accountService;
    private final PasswordResetService passwordResetService;

    public AuthController(AuthService authService, AccountService accountService,
            PasswordResetService passwordResetService) {
        this.authService = authService;
        this.accountService = accountService;
        this.passwordResetService = passwordResetService;
    }

    public record LoginRequest(@NotNull @Size(max = 64) String username, @NotNull @Size(max = 256) String password) {
    }

    public record RegisterRequest(@NotNull @Size(max = 64) String username,
            @NotNull @Size(min = AuthService.MIN_PASSWORD_LENGTH, max = 256, message = "密码长度需为 10–256 位") String password,
            @Size(max = 64, message = "昵称最长 64 个字符") String displayName) {
    }

    public record SetupRequest(@NotNull @Size(max = 256) String token,
            @NotNull @Size(min = AuthService.MIN_PASSWORD_LENGTH, max = 256, message = "密码长度需为 10–256 位") String password) {
    }

    /** 前端据此决定显示登录页 / 注册入口；未启用登录时 authenticated 恒为 true。 */
    public record ChangePasswordRequest(@NotNull @Size(max = 256) String oldPassword,
            @NotNull @Size(max = 256) String newPassword) {
    }

    public record DeleteAccountRequest(@NotNull @Size(max = 256) String password, @Size(max = 64) String confirmUsername) {
    }

    @GetMapping("/me")
    public Map<String, Object> me(HttpServletRequest request) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("authEnabled", authService.enabled());
        if (!authService.enabled()) {
            body.put("authenticated", true);
            return body;
        }
        HttpSession session = request.getSession(false);
        Object user = session == null ? null : session.getAttribute(AuthFilter.SESSION_USER);
        body.put("authenticated", user != null);
        if (user != null) {
            body.put("username", user);
            body.put("mustChangePassword", Boolean.TRUE.equals(session.getAttribute(AuthFilter.MUST_CHANGE)));
        } else {
            body.put("registrationEnabled", authService.registrationEnabled());
            body.put("setupAvailable", authService.setupAvailable());
        }
        return body;
    }

    @PostMapping("/login")
    public ResponseEntity<?> login(@Valid @RequestBody LoginRequest body, HttpServletRequest request) {
        if (!authService.enabled()) {
            return ResponseEntity.ok(Map.of("authEnabled", false, "authenticated", true));
        }
        AuthService.Result result = authService.authenticate(clientKey(request), body.username(), body.password());
        if (result instanceof AuthService.Locked locked) {
            return error(HttpStatus.TOO_MANY_REQUESTS, ErrorCodes.LOGIN_LOCKED,
                    "失败次数过多，请 " + locked.retryAfterSeconds() + " 秒后再试", request);
        }
        if (result instanceof AuthService.TempExpired) {
            return error(HttpStatus.UNAUTHORIZED, ErrorCodes.LOGIN_FAILED,
                    "临时密码已过期（24 小时内有效），请在登录页点「忘记密码」重新申请", request);
        }
        if (result instanceof AuthService.Ok ok) {
            return startSession(request, ok.userId(), ok.username(), ok.mustChangePassword());
        }
        return error(HttpStatus.UNAUTHORIZED, ErrorCodes.LOGIN_FAILED, "用户名或密码不正确", request);
    }

    /** 修改密码：要先输对当前密码（用临时密码登录的，当前密码就是临时密码）。 */
    @PostMapping("/password")
    public ResponseEntity<?> changePassword(@Valid @RequestBody ChangePasswordRequest body, HttpServletRequest request) {
        Long userId = sessionUserId(request);
        if (userId == null) {
            return error(HttpStatus.NOT_FOUND, ErrorCodes.RESOURCE_NOT_FOUND, "本机版没有登录密码", request);
        }
        AuthService.Result check = authService.verifyPassword(clientKey(request), userId, body.oldPassword());
        if (check instanceof AuthService.Locked locked) {
            return error(HttpStatus.TOO_MANY_REQUESTS, ErrorCodes.LOGIN_LOCKED,
                    "失败次数过多，请 " + locked.retryAfterSeconds() + " 秒后再试", request);
        }
        if (!(check instanceof AuthService.Ok)) {
            return error(HttpStatus.BAD_REQUEST, ErrorCodes.LOGIN_FAILED, "当前密码不正确", request);
        }
        authService.changePassword(userId, body.newPassword());
        request.getSession().removeAttribute(AuthFilter.MUST_CHANGE);
        return ResponseEntity.ok(Map.of("changed", true));
    }

    /** 注销账号：输入密码 + 用户名确认；成功后退出登录。站长账号不能注销。 */
    @PostMapping("/delete-account")
    public ResponseEntity<?> deleteAccount(@Valid @RequestBody DeleteAccountRequest body, HttpServletRequest request) {
        Long userId = sessionUserId(request);
        if (userId == null) {
            return error(HttpStatus.NOT_FOUND, ErrorCodes.RESOURCE_NOT_FOUND, "本机版不能注销账号", request);
        }
        AuthService.Result check = authService.verifyPassword(clientKey(request), userId, body.password());
        if (check instanceof AuthService.Locked locked) {
            return error(HttpStatus.TOO_MANY_REQUESTS, ErrorCodes.LOGIN_LOCKED,
                    "失败次数过多，请 " + locked.retryAfterSeconds() + " 秒后再试", request);
        }
        if (!(check instanceof AuthService.Ok)) {
            return error(HttpStatus.BAD_REQUEST, ErrorCodes.LOGIN_FAILED, "密码不正确", request);
        }
        try {
            accountService.deleteAccount(userId, body.confirmUsername());
        } catch (ForbiddenException ex) {
            return error(HttpStatus.FORBIDDEN, ErrorCodes.FORBIDDEN, ex.getMessage(), request);
        }
        HttpSession session = request.getSession(false);
        if (session != null) {
            session.invalidate();
        }
        return ResponseEntity.ok(Map.of("deleted", true));
    }

    /** 忘记密码申请（不需要登录）。不论用户名是否存在都返回同一句话。 */
    @PostMapping("/reset-request")
    public ResponseEntity<?> resetRequest(@RequestBody PasswordResetService.RequestBody body, HttpServletRequest request) {
        if (!authService.enabled()) {
            return error(HttpStatus.NOT_FOUND, ErrorCodes.RESOURCE_NOT_FOUND, "本机版没有登录密码", request);
        }
        passwordResetService.submit(body, clientKey(request));
        return ResponseEntity.ok(Map.of("message", "已提交。站长核对后会通过你留的联系方式发给你临时密码。"));
    }

    private static Long sessionUserId(HttpServletRequest request) {
        HttpSession session = request.getSession(false);
        Object id = session == null ? null : session.getAttribute(OwnerResolver.SESSION_USER_ID);
        return id instanceof Long value ? value : null;
    }

    /** 注册成功后直接登录。 */
    @PostMapping("/register")
    public ResponseEntity<?> register(@Valid @RequestBody RegisterRequest body, HttpServletRequest request) {
        if (!authService.registrationEnabled()) {
            return error(HttpStatus.NOT_FOUND, ErrorCodes.RESOURCE_NOT_FOUND, "暂未开放注册", request);
        }
        try {
            AppUser user = authService.register(clientKey(request), body.username(), body.password(), body.displayName());
            return startSession(request, user.getId(), user.getUsername());
        } catch (AuthService.RegistrationLimitException ex) {
            return error(HttpStatus.TOO_MANY_REQUESTS, ErrorCodes.REGISTRATION_LIMITED, ex.getMessage(), request);
        }
    }

    /** 站长凭一次性设置码设置密码；成功后直接登录。 */
    @PostMapping("/setup")
    public ResponseEntity<?> setup(@Valid @RequestBody SetupRequest body, HttpServletRequest request) {
        if (!authService.enabled() || !authService.setupAvailable()) {
            return error(HttpStatus.NOT_FOUND, ErrorCodes.RESOURCE_NOT_FOUND, "当前没有开放设置密码", request);
        }
        AuthService.Result result = authService.setupPassword(clientKey(request), body.token(), body.password());
        if (result instanceof AuthService.Locked locked) {
            return error(HttpStatus.TOO_MANY_REQUESTS, ErrorCodes.LOGIN_LOCKED,
                    "失败次数过多，请 " + locked.retryAfterSeconds() + " 秒后再试", request);
        }
        if (result instanceof AuthService.Ok ok) {
            return startSession(request, ok.userId(), ok.username());
        }
        return error(HttpStatus.FORBIDDEN, ErrorCodes.LOGIN_FAILED, "设置码不正确或已失效", request);
    }

    @PostMapping("/logout")
    public ResponseEntity<Void> logout(HttpServletRequest request) {
        HttpSession session = request.getSession(false);
        if (session != null) {
            session.invalidate();
        }
        return ResponseEntity.noContent().build();
    }

    /** 换一个新会话再写入用户（防会话固定攻击）。 */
    private static ResponseEntity<?> startSession(HttpServletRequest request, long userId, String username) {
        return startSession(request, userId, username, false);
    }

    private static ResponseEntity<?> startSession(HttpServletRequest request, long userId, String username,
            boolean mustChangePassword) {
        HttpSession old = request.getSession(false);
        if (old != null) {
            old.invalidate();
        }
        HttpSession session = request.getSession(true);
        session.setAttribute(AuthFilter.SESSION_USER, username);
        session.setAttribute(OwnerResolver.SESSION_USER_ID, userId);
        if (mustChangePassword) {
            session.setAttribute(AuthFilter.MUST_CHANGE, Boolean.TRUE);
        }
        return ResponseEntity.ok(Map.of("authEnabled", true, "authenticated", true, "username", username,
                "mustChangePassword", mustChangePassword));
    }

    /** 服务器在 Nginx 之后：Nginx 会写入 X-Real-IP；直连时用对端地址。 */
    private static String clientKey(HttpServletRequest request) {
        String real = request.getHeader("X-Real-IP");
        return real != null && !real.isBlank() ? real.trim() : request.getRemoteAddr();
    }

    private static ResponseEntity<ApiError> error(HttpStatus status, String code, String message,
            HttpServletRequest request) {
        return ResponseEntity.status(status)
                .body(ApiError.of(status.value(), status.getReasonPhrase(), code, message, request.getRequestURI()));
    }
}
