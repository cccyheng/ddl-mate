package com.ddlmate.web;

import org.springframework.stereotype.Controller;
import org.springframework.web.bind.annotation.GetMapping;

/**
 * 单页应用回退：前端用 history 路由，直接访问 /tasks、/calendar 这类地址时也要能返回 index.html。
 *
 * <p>规则：</p>
 * <ul>
 *   <li><b>不映射 /index.html</b>，避免 forward:/index.html 递归转发自身；</li>
 *   <li><b>不兜底 /api/**</b>，不存在的接口仍然是标准的 404 JSON 错误；</li>
 *   <li>注解值必须内联字面量：Java 注解属性不接受 String[] 变量。</li>
 * </ul>
 */
@Controller
public class SpaController {

    @GetMapping({
            "/",
            "/tasks", "/tasks/**",
            "/courses", "/courses/**",
            "/calendar", "/calendar/**",
            "/sources", "/sources/**",
            "/about", "/about/**",
            "/focus", "/focus/**",
            "/plan", "/plan/**",
            "/exams", "/exams/**",
            "/search", "/search/**",
            "/tools", "/tools/**",
            "/login", "/setup", "/register"
    })
    public String index() {
        return "forward:/index.html";
    }
}
