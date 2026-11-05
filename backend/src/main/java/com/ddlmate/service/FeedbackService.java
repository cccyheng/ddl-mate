package com.ddlmate.service;

import java.time.OffsetDateTime;
import java.util.List;
import java.util.Set;

import org.springframework.data.domain.PageRequest;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import com.ddlmate.auth.AuthService;
import com.ddlmate.common.ErrorCodes;
import com.ddlmate.common.ForbiddenException;
import com.ddlmate.common.InvalidRequestException;
import com.ddlmate.common.ResourceInUseException;
import com.ddlmate.common.ResourceNotFoundException;
import com.ddlmate.common.TimeZones;
import com.ddlmate.domain.AppUser;
import com.ddlmate.domain.Feedback;
import com.ddlmate.repository.FeedbackRepository;

/**
 * 问题反馈：任何登录用户都能提交、查看自己提交过的；只有站长（ADMIN）能看全部、标记处理、回复。
 * 本机单人版（未启用登录）里唯一的用户就是站长。
 */
@Service
public class FeedbackService {

    public static final int MAX_PER_DAY = 10;
    private static final Set<String> CATEGORIES = Set.of("BUG", "SUGGESTION", "OTHER");
    private static final Set<String> STATUSES = Set.of(Feedback.NEW, Feedback.READ, Feedback.DONE);

    public record SubmitRequest(String category, String content, String contact, String page) {
    }

    public record UpdateRequest(String status, String reply) {
    }

    public record FeedbackView(Long id, String username, String category, String content, String contact,
            String page, String userAgent, String status, String reply, OffsetDateTime repliedAt,
            OffsetDateTime createdAt) {
    }

    private final FeedbackRepository repository;
    private final UserService userService;
    private final AuthService authService;

    public FeedbackService(FeedbackRepository repository, UserService userService, AuthService authService) {
        this.repository = repository;
        this.userService = userService;
        this.authService = authService;
    }

    @Transactional
    public FeedbackView submit(SubmitRequest request, String userAgent) {
        if (request == null) {
            throw new InvalidRequestException("content", "反馈内容不能为空");
        }
        String content = trim(request.content());
        if (content == null) {
            throw new InvalidRequestException("content", "请写下遇到的问题或建议");
        }
        if (content.length() > 2000) {
            throw new InvalidRequestException("content", "反馈内容最多 2000 字");
        }
        String category = request.category() == null ? "OTHER" : request.category().trim().toUpperCase();
        if (!CATEGORIES.contains(category)) {
            throw new InvalidRequestException("category", "反馈类型只能是问题、建议或其他");
        }
        String contact = trim(request.contact());
        if (contact != null && contact.length() > 100) {
            throw new InvalidRequestException("contact", "联系方式最多 100 字");
        }
        AppUser user = userService.currentUser();
        long recent = repository.countByUserIdAndCreatedAtAfter(user.getId(), TimeZones.now().minusHours(24));
        if (recent >= MAX_PER_DAY) {
            throw new ResourceInUseException("24 小时内最多提交 " + MAX_PER_DAY + " 条反馈，请稍后再试。",
                    ErrorCodes.FEEDBACK_LIMITED);
        }
        Feedback feedback = new Feedback(user.getId(), user.getUsername(), category, content);
        feedback.setContact(contact);
        feedback.setPage(cut(trim(request.page()), 200));
        feedback.setUserAgent(cut(trim(userAgent), 300));
        return view(repository.save(feedback));
    }

    @Transactional(readOnly = true)
    public List<FeedbackView> mine() {
        AppUser user = userService.currentUser();
        return repository.findByUserIdOrderByIdDesc(user.getId(), PageRequest.of(0, 100)).stream().map(this::view).toList();
    }

    /** 当前用户是不是站长：登录版看角色；本机单人版没有登录，唯一的用户就是站长。 */
    @Transactional(readOnly = true)
    public boolean isAdmin() {
        return !authService.enabled() || userService.currentUser().isAdmin();
    }

    @Transactional(readOnly = true)
    public List<FeedbackView> all(String status) {
        requireAdmin();
        PageRequest page = PageRequest.of(0, 500);
        List<Feedback> list = status == null || status.isBlank()
                ? repository.findAllByOrderByIdDesc(page)
                : repository.findByStatusOrderByIdDesc(requireStatus(status), page);
        return list.stream().map(this::view).toList();
    }

    @Transactional(readOnly = true)
    public long unreadCount() {
        requireAdmin();
        return repository.countByStatus(Feedback.NEW);
    }

    @Transactional
    public FeedbackView update(Long id, UpdateRequest request) {
        requireAdmin();
        Feedback feedback = repository.findById(id).orElseThrow(() -> new ResourceNotFoundException("反馈", id));
        if (request.status() != null) {
            feedback.setStatus(requireStatus(request.status()));
        }
        if (request.reply() != null) {
            String reply = trim(request.reply());
            if (reply != null && reply.length() > 1000) {
                throw new InvalidRequestException("reply", "回复最多 1000 字");
            }
            feedback.setReply(reply);
            feedback.setRepliedAt(reply == null ? null : TimeZones.now());
            if (reply != null && Feedback.NEW.equals(feedback.getStatus())) {
                feedback.setStatus(Feedback.READ);
            }
        }
        return view(repository.save(feedback));
    }

    private void requireAdmin() {
        if (!isAdmin()) {
            throw new ForbiddenException("只有站长可以查看和处理全部反馈。");
        }
    }

    private static String requireStatus(String status) {
        String value = status.trim().toUpperCase();
        if (!STATUSES.contains(value)) {
            throw new InvalidRequestException("status", "状态只能是 NEW / READ / DONE");
        }
        return value;
    }

    private FeedbackView view(Feedback f) {
        return new FeedbackView(f.getId(), f.getUsername(), f.getCategory(), f.getContent(), f.getContact(),
                f.getPage(), f.getUserAgent(), f.getStatus(), f.getReply(), f.getRepliedAt(), f.getCreatedAt());
    }

    private static String trim(String value) {
        if (value == null) {
            return null;
        }
        String trimmed = value.trim();
        return trimmed.isEmpty() ? null : trimmed;
    }

    private static String cut(String value, int max) {
        return value == null || value.length() <= max ? value : value.substring(0, max);
    }
}
