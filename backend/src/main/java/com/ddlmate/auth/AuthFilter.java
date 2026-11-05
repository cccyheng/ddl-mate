package com.ddlmate.auth;

import java.io.IOException;
import java.net.URI;
import java.util.Set;

import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

import com.ddlmate.common.ApiError;
import com.ddlmate.common.ErrorCodes;
import com.ddlmate.common.TimeZones;
import com.fasterxml.jackson.databind.ObjectMapper;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import jakarta.servlet.http.HttpSession;

/**
 * 登录拦截：启用登录后，除登录相关接口外的所有 {@code /api/**} 都要求已登录的会话。
 *
 * <ul>
 *   <li>页面与静态资源照常返回（里面没有数据），由前端在拿到 401 后跳到登录页；</li>
 *   <li>H2 控制台一律拒绝，避免绕过登录直接读库；</li>
 *   <li>写操作额外校验 Origin / Referer 与本站一致（配合 SameSite=Strict 的会话 Cookie 防 CSRF）。</li>
 * </ul>
 */
@Component
@Order(Ordered.HIGHEST_PRECEDENCE + 10)
public class AuthFilter extends OncePerRequestFilter {

    public static final String SESSION_USER = "ddlmate.auth.user";

    private static final Set<String> OPEN_API = Set.of("/api/auth/login", "/api/auth/me", "/api/auth/logout",
            "/api/auth/setup", "/api/auth/register");
    private static final Set<String> SAFE_METHODS = Set.of("GET", "HEAD", "OPTIONS");

    private final AuthService authService;
    private final ObjectMapper objectMapper;

    public AuthFilter(AuthService authService, ObjectMapper objectMapper) {
        this.authService = authService;
        this.objectMapper = objectMapper;
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
            throws ServletException, IOException {
        if (!authService.enabled()) {
            chain.doFilter(request, response);
            return;
        }
        String path = request.getRequestURI().substring(request.getContextPath().length());
        if (path.startsWith("/h2-console")) {
            reject(response, request, HttpStatus.NOT_FOUND, ErrorCodes.RESOURCE_NOT_FOUND, "不存在");
            return;
        }
        if (!path.startsWith("/api/")) {
            chain.doFilter(request, response);
            return;
        }
        if (!SAFE_METHODS.contains(request.getMethod()) && !sameOrigin(request)) {
            reject(response, request, HttpStatus.FORBIDDEN, ErrorCodes.FORBIDDEN_ORIGIN, "请求来源不被允许");
            return;
        }
        if (OPEN_API.contains(path)) {
            chain.doFilter(request, response);
            return;
        }
        HttpSession session = request.getSession(false);
        if (session == null || session.getAttribute(SESSION_USER) == null
                || !(session.getAttribute(com.ddlmate.tenant.OwnerResolver.SESSION_USER_ID) instanceof Long)) {
            reject(response, request, HttpStatus.UNAUTHORIZED, ErrorCodes.UNAUTHENTICATED, "请先登录");
            return;
        }
        chain.doFilter(request, response);
    }

    /**
     * 浏览器写请求都会带 Origin（老浏览器带 Referer）；两者都缺时按非浏览器客户端拒绝。
     * 只比较主机名：同一主机的不同端口在 SameSite 语义下本来就是同站，而端口在反向代理后并不可靠。
     */
    static boolean sameOrigin(HttpServletRequest request) {
        String origin = request.getHeader("Origin");
        String source = origin != null && !"null".equals(origin) ? origin : request.getHeader("Referer");
        if (source == null) {
            return false;
        }
        try {
            String host = URI.create(source).getHost();
            return host != null && host.equalsIgnoreCase(request.getServerName());
        } catch (IllegalArgumentException ex) {
            return false;
        }
    }

    private void reject(HttpServletResponse response, HttpServletRequest request, HttpStatus status, String code,
            String message) throws IOException {
        response.setStatus(status.value());
        response.setContentType(MediaType.APPLICATION_JSON_VALUE);
        response.setCharacterEncoding("UTF-8");
        ApiError error = new ApiError(TimeZones.now(), status.value(), status.getReasonPhrase(), code, message,
                request.getRequestURI(), null);
        objectMapper.writeValue(response.getOutputStream(), error);
    }
}
