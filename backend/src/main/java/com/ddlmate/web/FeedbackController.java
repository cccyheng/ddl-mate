package com.ddlmate.web;

import java.util.List;
import java.util.Map;

import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

import com.ddlmate.service.FeedbackService;
import com.ddlmate.service.FeedbackService.FeedbackView;
import com.ddlmate.service.PasswordResetService;

/** 问题反馈：用户提交 / 看自己的；站长看全部、标记状态、回复。 */
@RestController
public class FeedbackController {

    private final FeedbackService feedbackService;
    private final PasswordResetService passwordResetService;

    public FeedbackController(FeedbackService feedbackService, PasswordResetService passwordResetService) {
        this.feedbackService = feedbackService;
        this.passwordResetService = passwordResetService;
    }

    @PostMapping("/api/feedback")
    @ResponseStatus(HttpStatus.CREATED)
    public FeedbackView submit(@RequestBody FeedbackService.SubmitRequest request,
            @RequestHeader(value = "User-Agent", required = false) String userAgent) {
        return feedbackService.submit(request, userAgent);
    }

    @GetMapping("/api/feedback/mine")
    public List<FeedbackView> mine() {
        return feedbackService.mine();
    }

    /** 前端用来决定是否显示「全部反馈」与未读数。 */
    @GetMapping("/api/feedback/role")
    public Map<String, Object> role() {
        boolean admin = feedbackService.isAdmin();
        return admin
                ? Map.of("admin", true, "unread", feedbackService.unreadCount(), "resetPending",
                        passwordResetService.pendingCount())
                : Map.of("admin", false);
    }

    @GetMapping("/api/admin/feedback")
    public List<FeedbackView> all(@RequestParam(required = false) String status) {
        return feedbackService.all(status);
    }

    @PatchMapping("/api/admin/feedback/{id}")
    public FeedbackView update(@PathVariable Long id, @RequestBody FeedbackService.UpdateRequest request) {
        return feedbackService.update(id, request);
    }
}
