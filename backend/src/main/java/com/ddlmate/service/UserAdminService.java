package com.ddlmate.service;

import java.time.OffsetDateTime;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import org.springframework.data.domain.PageRequest;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import com.ddlmate.common.ForbiddenException;
import com.ddlmate.common.InvalidRequestException;
import com.ddlmate.common.ResourceNotFoundException;
import com.ddlmate.common.TimeZones;
import com.ddlmate.domain.AppUser;
import com.ddlmate.domain.LoginEvent;
import com.ddlmate.repository.AppUserRepository;
import com.ddlmate.repository.LoginEventRepository;

/**
 * 站长的「用户管理」：看所有账号（注册时间、登录记录、数据量）、封号 / 解封。
 * 只给出数量，不展示别人的课程、任务等具体内容。
 */
@Service
public class UserAdminService {

    public record UserRow(Long id, String username, String displayName, String role, OffsetDateTime createdAt,
            OffsetDateTime lastLoginAt, long loginCount, long courses, long tasks, boolean disabled,
            OffsetDateTime disabledAt, String disabledReason) {
    }

    public record LoginRow(String kind, String ip, String userAgent, OffsetDateTime createdAt) {
    }

    public record BanRequest(String reason) {
    }

    private final AppUserRepository users;
    private final LoginEventRepository logins;
    private final JdbcTemplate jdbc;
    private final AdminGuard adminGuard;
    private final UserService userService;

    public UserAdminService(AppUserRepository users, LoginEventRepository logins, JdbcTemplate jdbc,
            AdminGuard adminGuard, UserService userService) {
        this.users = users;
        this.logins = logins;
        this.jdbc = jdbc;
        this.adminGuard = adminGuard;
        this.userService = userService;
    }

    @Transactional(readOnly = true)
    public List<UserRow> list() {
        adminGuard.requireAdmin();
        Map<Long, Long> loginCounts = new HashMap<>();
        for (Object[] row : logins.countByUser()) {
            loginCounts.put((Long) row[0], (Long) row[1]);
        }
        Map<Long, Long> courseCounts = countByOwner("courses");
        Map<Long, Long> taskCounts = countByOwner("tasks");
        return users.findAllOrdered().stream()
                .map(u -> new UserRow(u.getId(), u.getUsername(), u.getDisplayName(), u.isAdmin() ? "ADMIN" : "USER",
                        u.getCreatedAt(), u.getLastLoginAt(), loginCounts.getOrDefault(u.getId(), 0L),
                        courseCounts.getOrDefault(u.getId(), 0L), taskCounts.getOrDefault(u.getId(), 0L),
                        u.isDisabled(), u.getDisabledAt(), u.getDisabledReason()))
                .toList();
    }

    @Transactional(readOnly = true)
    public List<LoginRow> logins(Long userId) {
        adminGuard.requireAdmin();
        requireUser(userId);
        return logins.findByUserIdOrderByIdDesc(userId, PageRequest.of(0, 100)).stream()
                .map(e -> new LoginRow(e.getKind(), e.getIp(), e.getUserAgent(), e.getCreatedAt()))
                .toList();
    }

    @Transactional
    public UserRow ban(Long userId, String reason) {
        adminGuard.requireAdmin();
        AppUser user = requireUser(userId);
        if (user.isAdmin() || user.getId().equals(userService.currentUser().getId())) {
            throw new ForbiddenException("不能封禁站长账号。");
        }
        String text = reason == null ? null : reason.trim();
        if (text != null && text.length() > 200) {
            throw new InvalidRequestException("reason", "封号原因最多 200 字");
        }
        user.setDisabled(true);
        user.setDisabledAt(TimeZones.now());
        user.setDisabledReason(text == null || text.isEmpty() ? null : text);
        users.save(user);
        return row(user);
    }

    @Transactional
    public UserRow unban(Long userId) {
        adminGuard.requireAdmin();
        AppUser user = requireUser(userId);
        user.setDisabled(false);
        user.setDisabledAt(null);
        user.setDisabledReason(null);
        users.save(user);
        return row(user);
    }

    /** 记录一次成功登录（登录 / 注册 / 站长设置密码），并更新最近登录时间。 */
    @Transactional
    public void recordLogin(long userId, String kind, String ip, String userAgent) {
        users.findById(userId).ifPresent(user -> {
            logins.save(new LoginEvent(userId, kind, ip, userAgent));
            user.setLastLoginAt(TimeZones.now());
            users.save(user);
        });
    }

    private UserRow row(AppUser u) {
        return list().stream().filter(r -> r.id().equals(u.getId())).findFirst().orElseThrow();
    }

    private AppUser requireUser(Long id) {
        return users.findById(id).orElseThrow(() -> new ResourceNotFoundException("账号", id));
    }

    private Map<Long, Long> countByOwner(String table) {
        Map<Long, Long> counts = new HashMap<>();
        jdbc.query("SELECT owner_id, COUNT(*) FROM " + table + " GROUP BY owner_id",
                rs -> {
                    counts.put(rs.getLong(1), rs.getLong(2));
                });
        return counts;
    }
}
