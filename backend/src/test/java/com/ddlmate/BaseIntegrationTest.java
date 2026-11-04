package com.ddlmate;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

import org.junit.jupiter.api.BeforeEach;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.MockMvc;

import com.ddlmate.repository.AppSettingRepository;
import com.ddlmate.repository.AttachmentRepository;
import com.ddlmate.repository.CourseRepository;
import com.ddlmate.repository.CourseScheduleRepository;
import com.ddlmate.repository.TaskRepository;
import com.ddlmate.repository.TaskSourceRepository;

/**
 * 集成测试基类：完整 Spring 上下文 + MockMvc + H2 内存库。
 * 每个测试方法开始前清空业务数据，保证用例互不依赖。
 */
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("test")
public abstract class BaseIntegrationTest {

    static final Path UPLOAD_DIR = createTempUploadDir();

    @Autowired
    protected MockMvc mvc;

    @Autowired
    protected CourseRepository courseRepository;

    @Autowired
    protected CourseScheduleRepository scheduleRepository;

    @Autowired
    protected TaskRepository taskRepository;

    @Autowired
    protected TaskSourceRepository sourceRepository;

    @Autowired
    protected AttachmentRepository attachmentRepository;

    @Autowired
    protected AppSettingRepository settingRepository;

    @DynamicPropertySource
    static void storageProperties(DynamicPropertyRegistry registry) {
        registry.add("ddlmate.storage.upload-dir", () -> UPLOAD_DIR.toString());
    }

    @BeforeEach
    void cleanDatabase() {
        attachmentRepository.deleteAll();
        sourceRepository.deleteAll();
        taskRepository.deleteAll();
        scheduleRepository.deleteAll();
        courseRepository.deleteAll();
        settingRepository.deleteAll();
    }

    private static Path createTempUploadDir() {
        try {
            Path dir = Files.createTempDirectory("ddlmate-test-uploads-");
            dir.toFile().deleteOnExit();
            return dir;
        } catch (IOException ex) {
            throw new IllegalStateException("无法创建测试上传目录", ex);
        }
    }

    /** 生成一张合法的 1x1 PNG（带正确文件头，供类型嗅探通过）。 */
    protected static byte[] tinyPng() {
        return new byte[] {
                (byte) 0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,
                0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52,
                0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
                0x08, 0x06, 0x00, 0x00, 0x00, 0x1F, 0x15, (byte) 0xC4,
                (byte) 0x89, 0x00, 0x00, 0x00, 0x0A, 0x49, 0x44, 0x41,
                0x54, 0x78, (byte) 0x9C, 0x63, 0x00, 0x01, 0x00, 0x00,
                0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D, (byte) 0xB4,
                0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44,
                (byte) 0xAE, 0x42, 0x60, (byte) 0x82
        };
    }

    protected static List<String> weekdays() {
        return List.of("周一", "周二", "周三", "周四", "周五", "周六", "周日");
    }
}
