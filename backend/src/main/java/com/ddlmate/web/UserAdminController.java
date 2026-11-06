package com.ddlmate.web;

import java.util.List;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import com.ddlmate.service.UserAdminService;
import com.ddlmate.service.UserAdminService.LoginRow;
import com.ddlmate.service.UserAdminService.UserRow;

/** 站长的用户管理：账号列表、登录记录、封号 / 解封。 */
@RestController
@RequestMapping("/api/admin/users")
public class UserAdminController {

    private final UserAdminService service;

    public UserAdminController(UserAdminService service) {
        this.service = service;
    }

    @GetMapping
    public List<UserRow> list() {
        return service.list();
    }

    @GetMapping("/{id}/logins")
    public List<LoginRow> logins(@PathVariable Long id) {
        return service.logins(id);
    }

    @PostMapping("/{id}/ban")
    public UserRow ban(@PathVariable Long id, @RequestBody(required = false) UserAdminService.BanRequest body) {
        return service.ban(id, body == null ? null : body.reason());
    }

    @PostMapping("/{id}/unban")
    public UserRow unban(@PathVariable Long id) {
        return service.unban(id);
    }
}
