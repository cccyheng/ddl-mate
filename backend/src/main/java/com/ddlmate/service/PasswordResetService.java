package com.ddlmate.service;

import java.time.OffsetDateTime;
import java.util.List;
import java.util.Locale;

import org.springframework.data.domain.PageRequest;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import com.ddlmate.auth.AuthService;
import com.ddlmate.common.ErrorCodes;
import com.ddlmate.common.InvalidRequestException;
import com.ddlmate.common.ResourceInUseException;
import com.ddlmate.common.ResourceNotFoundException;
import com.ddlmate.common.TimeZones;
import com.ddlmate.domain.PasswordResetRequest;
import com.ddlmate.repository.AppUserRepository;
import com.ddlmate.repository.PasswordResetRequestRepository;

/**
 * 忘记密码：账号没有邮箱 / 手机，所以由用户留下联系方式提交申请，站长核对后生成临时密码发给他。
 * 对申请人始终返回同一句话，不透露这个用户名是否存在。
 */
@Service
public class PasswordResetService {

    public static final int PER_SOURCE_PER_HOUR = 3;
    public static final int PER_DAY = 50;

    public record RequestBody(String username, String contact, String note) {
    }

    public record RequestView(Long id, String username, boolean accountExists, String contact, String note,
            String status, OffsetDateTime createdAt, OffsetDateTime handledAt) {
    }

    public record IssuedPassword(String username, String tempPassword, String expiresIn) {
    }

    private final PasswordResetRequestRepository repository;
    private final AppUserRepository users;
    private final AuthService authService;
    private final AdminGuard adminGuard;

    public PasswordResetService(PasswordResetRequestRepository repository, AppUserRepository users,
            AuthService authService, AdminGuard adminGuard) {
        this.repository = repository;
        this.users = users;
        this.authService = authService;
        this.adminGuard = adminGuard;
    }

    @Transactional
    public void submit(RequestBody body, String clientKey) {
        String username = body == null || body.username() == null ? "" : body.username().trim().toLowerCase(Locale.ROOT);
        String contact = body == null || body.contact() == null ? "" : body.contact().trim();
        String note = body == null || body.note() == null ? null : body.note().trim();
        if (username.isEmpty() || username.length() > 64) {
            throw new InvalidRequestException("username", "请填写你的用户名");
        }
        if (contact.isEmpty()) {
            throw new InvalidRequestException("contact", "请留下联系方式（QQ / 微信 / 邮箱），站长要通过它把临时密码发给你");
        }
        if (contact.length() > 100) {
            throw new InvalidRequestException("contact", "联系方式最多 100 字");
        }
        if (note != null && note.length() > 500) {
            throw new InvalidRequestException("note", "补充说明最多 500 字");
        }
        OffsetDateTime now = TimeZones.now();
        String key = clientKey == null ? "unknown" : clientKey.substring(0, Math.min(64, clientKey.length()));
        if (repository.countByClientKeyAndCreatedAtAfter(key, now.minusHours(1)) >= PER_SOURCE_PER_HOUR
                || repository.countByCreatedAtAfter(now.minusDays(1)) >= PER_DAY) {
            throw new ResourceInUseException("提交太频繁了，请稍后再试。", ErrorCodes.RESET_LIMITED);
        }
        Long userId = users.findByUsernameIgnoreCase(username).map(u -> u.getId()).orElse(null);
        repository.save(new PasswordResetRequest(username, userId, contact, note == null || note.isEmpty() ? null : note, key));
    }

    @Transactional(readOnly = true)
    public List<RequestView> list() {
        adminGuard.requireAdmin();
        return repository.findAllByOrderByIdDesc(PageRequest.of(0, 200)).stream()
                .map(r -> new RequestView(r.getId(), r.getUsername(),
                        r.getUserId() != null && users.existsById(r.getUserId()), r.getContact(), r.getNote(),
                        r.getStatus(), r.getCreatedAt(), r.getHandledAt()))
                .toList();
    }

    @Transactional(readOnly = true)
    public long pendingCount() {
        adminGuard.requireAdmin();
        return repository.countByStatus(PasswordResetRequest.PENDING);
    }

    /** 生成临时密码（只在这次响应里出现一次），申请标记为已处理。 */
    @Transactional
    public IssuedPassword issue(Long id) {
        adminGuard.requireAdmin();
        PasswordResetRequest request = repository.findById(id)
                .orElseThrow(() -> new ResourceNotFoundException("找回密码申请", id));
        if (request.getUserId() == null || !users.existsById(request.getUserId())) {
            throw new InvalidRequestException("这个用户名不存在（可能填错了），请通过联系方式和对方确认。");
        }
        String temp = authService.issueTempPassword(request.getUserId());
        request.setStatus(PasswordResetRequest.ISSUED);
        repository.save(request);
        return new IssuedPassword(request.getUsername(), temp, "24 小时");
    }

    @Transactional
    public void dismiss(Long id) {
        adminGuard.requireAdmin();
        PasswordResetRequest request = repository.findById(id)
                .orElseThrow(() -> new ResourceNotFoundException("找回密码申请", id));
        request.setStatus(PasswordResetRequest.DISMISSED);
        repository.save(request);
    }
}
