package com.ddlmate.web;

import java.util.List;

import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import com.ddlmate.service.PasswordResetService;
import com.ddlmate.service.PasswordResetService.IssuedPassword;
import com.ddlmate.service.PasswordResetService.RequestView;

/** 站长处理「忘记密码」申请：查看、生成临时密码、忽略。 */
@RestController
@RequestMapping("/api/admin/reset-requests")
public class PasswordResetController {

    private final PasswordResetService service;

    public PasswordResetController(PasswordResetService service) {
        this.service = service;
    }

    @GetMapping
    public List<RequestView> list() {
        return service.list();
    }

    @PostMapping("/{id}/issue")
    public IssuedPassword issue(@PathVariable Long id) {
        return service.issue(id);
    }

    @PostMapping("/{id}/dismiss")
    public ResponseEntity<Void> dismiss(@PathVariable Long id) {
        service.dismiss(id);
        return ResponseEntity.noContent().build();
    }
}
