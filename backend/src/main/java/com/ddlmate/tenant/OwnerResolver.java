package com.ddlmate.tenant;

import java.util.concurrent.atomic.AtomicLong;

import org.hibernate.context.spi.CurrentTenantIdentifierResolver;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;
import org.springframework.web.context.request.RequestAttributes;
import org.springframework.web.context.request.RequestContextHolder;

import com.ddlmate.auth.AuthProperties;

/**
 * 每次打开数据库会话时决定「当前是谁的数据」，Hibernate 据此给带 {@code @TenantId} 的实体
 * 自动加上 {@code owner_id = ?} 过滤，并在新增时写入 owner_id。
 *
 * <ol>
 *   <li>{@link OwnerContext#runAs} 临时指定的（迁移、示例数据）；</li>
 *   <li>登录会话里的用户 id；</li>
 *   <li>未启用登录（本机单人版）时：本机唯一用户；</li>
 *   <li>其余情况（启用登录但未登录）：{@link OwnerContext#ANONYMOUS}，看不到任何数据。</li>
 * </ol>
 */
@Component
public class OwnerResolver implements CurrentTenantIdentifierResolver<Long> {

    /** 会话里保存登录用户 id 的属性名。 */
    public static final String SESSION_USER_ID = "ddlmate.auth.userId";

    private final AuthProperties authProperties;
    private final JdbcTemplate jdbc;
    private final AtomicLong localUserId = new AtomicLong(0);

    public OwnerResolver(AuthProperties authProperties, JdbcTemplate jdbc) {
        this.authProperties = authProperties;
        this.jdbc = jdbc;
    }

    @Override
    public Long resolveCurrentTenantIdentifier() {
        Long override = OwnerContext.override();
        if (override != null) {
            return override;
        }
        RequestAttributes attributes = RequestContextHolder.getRequestAttributes();
        if (attributes != null) {
            Object id = attributes.getAttribute(SESSION_USER_ID, RequestAttributes.SCOPE_SESSION);
            if (id instanceof Long userId) {
                return userId;
            }
        }
        if (!authProperties.enabled()) {
            return localUserId();
        }
        return OwnerContext.ANONYMOUS;
    }

    /** 本机单人版：用户表里最早的那个用户（启动时由 UserService 保证存在）。 */
    public long localUserId() {
        long cached = localUserId.get();
        if (cached > 0) {
            return cached;
        }
        Long id = jdbc.queryForObject("SELECT MIN(id) FROM app_users", Long.class);
        if (id == null) {
            return OwnerContext.ANONYMOUS;
        }
        localUserId.compareAndSet(0, id);
        return id;
    }

    @Override
    public boolean validateExistingCurrentSessions() {
        return false;
    }

    @Override
    public boolean isRoot(Long tenantId) {
        return tenantId != null && tenantId == OwnerContext.SYSTEM;
    }
}
