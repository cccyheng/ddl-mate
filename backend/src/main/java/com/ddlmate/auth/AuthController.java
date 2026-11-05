package com.ddlmate.auth;

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

import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpSession;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;

/** 单人登录：登录 / 退出 / 当前状态。 */
@RestController
@RequestMapping("/api/auth")
public class AuthController {

    private final AuthService authService;

    public AuthController(AuthService authService) {
        this.authService = authService;
    }

    public record LoginRequest(@NotNull @Size(max = 64) String username, @NotNull @Size(max = 256) String password) {
    }

    /** 前端据此决定是否显示登录页；未启用登录时 authenticated 恒为 true。 */
    @GetMapping("/me")
    public Map<String, Object> me(HttpServletRequest request) {
        if (!authService.enabled()) {
            return Map.of("authEnabled", false, "authenticated", true);
        }
        HttpSession session = request.getSession(false);
        Object user = session == null ? null : session.getAttribute(AuthFilter.SESSION_USER);
        return user == null
                ? Map.of("authEnabled", true, "authenticated", false, "setupAvailable", authService.setupAvailable())
                : Map.of("authEnabled", true, "authenticated", true, "username", user);
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
        if (result instanceof AuthService.Rejected) {
            return error(HttpStatus.UNAUTHORIZED, ErrorCodes.LOGIN_FAILED, "用户名或密码不正确", request);
        }
        // 登录成功换一个新会话，防止会话固定攻击
        HttpSession old = request.getSession(false);
        if (old != null) {
            old.invalidate();
        }
        HttpSession session = request.getSession(true);
        session.setAttribute(AuthFilter.SESSION_USER, authService.username());
        return ResponseEntity.ok(Map.of("authEnabled", true, "authenticated", true, "username", authService.username()));
    }

    public record SetupRequest(@NotNull @Size(max = 256) String token,
            @NotNull @Size(min = AuthService.MIN_PASSWORD_LENGTH, max = 256, message = "密码长度需为 10–256 位") String password) {
    }

    /** 凭一次性设置码设置密码；成功后直接登录。 */
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
        if (result instanceof AuthService.Rejected) {
            return error(HttpStatus.FORBIDDEN, ErrorCodes.LOGIN_FAILED, "设置码不正确或已失效", request);
        }
        return login(new LoginRequest(authService.username(), body.password()), request);
    }

    @PostMapping("/logout")
    public ResponseEntity<Void> logout(HttpServletRequest request) {
        HttpSession session = request.getSession(false);
        if (session != null) {
            session.invalidate();
        }
        return ResponseEntity.noContent().build();
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
