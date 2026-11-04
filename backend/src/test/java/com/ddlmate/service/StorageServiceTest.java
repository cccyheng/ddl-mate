package com.ddlmate.service;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.stream.Stream;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockMultipartFile;

import com.ddlmate.common.FileStorageException;

/**
 * 附件文件类型嗅探的纯单元测试（不需要 Spring 上下文）。
 *
 * <p>重点：只认文件头魔数，客户端声明的 Content-Type 不参与判定。</p>
 */
class StorageServiceTest {

    @Test
    @DisplayName("识别真实的 PNG / JPEG / GIF / WebP")
    void detectsRealImages() {
        assertThat(StorageService.detectContentType(png())).isEqualTo("image/png");
        assertThat(StorageService.detectContentType(new byte[] {(byte) 0xFF, (byte) 0xD8, (byte) 0xFF, (byte) 0xE0, 0, 0}))
                .isEqualTo("image/jpeg");
        assertThat(StorageService.detectContentType("GIF89a".getBytes(StandardCharsets.US_ASCII)))
                .isEqualTo("image/gif");
        assertThat(StorageService.detectContentType(riffWebp())).isEqualTo("image/webp");
    }

    @Test
    @DisplayName("HTML / 文本 / 截断的 PNG 签名都识别为未知类型（返回 null）")
    void rejectsUnknownSignatures() {
        assertThat(StorageService.detectContentType(null)).isNull();
        assertThat(StorageService.detectContentType(new byte[] {1, 2})).isNull();
        assertThat(StorageService.detectContentType("<!DOCTYPE html>".getBytes(StandardCharsets.UTF_8))).isNull();
        assertThat(StorageService.detectContentType("PK\u0003\u0004zip".getBytes(StandardCharsets.UTF_8))).isNull();
        // 只有前 4 字节 PNG 魔数、缺完整 8 字节签名
        assertThat(StorageService.detectContentType(new byte[] {(byte) 0x89, 0x50, 0x4E, 0x47, 0, 0, 0, 0})).isNull();
        // 只有 4 字节根本不够判定
        assertThat(StorageService.detectContentType(new byte[] {(byte) 0x89, 0x50, 0x4E, 0x47})).isNull();
    }

    @Test
    @DisplayName("扩展名由识别出的真实类型决定，不沿用用户文件名")
    void extensionComesFromDetectedType() {
        assertThat(StorageService.extensionFor("image/png", "evil.html")).isEqualTo(".png");
        assertThat(StorageService.extensionFor("image/jpeg", "evil.exe")).isEqualTo(".jpg");
        assertThat(StorageService.extensionFor("image/gif", "x")).isEqualTo(".gif");
        assertThat(StorageService.extensionFor("image/webp", "x")).isEqualTo(".webp");
    }

    @Test
    @DisplayName("原始文件名被净化：去掉目录、控制字符与 Windows 非法字符")
    void sanitizesOriginalNames() {
        assertThat(StorageService.sanitizeOriginalName("../../../evil.png")).isEqualTo("evil.png");
        assertThat(StorageService.sanitizeOriginalName("C:\\Users\\me\\群消息截图.png")).isEqualTo("群消息截图.png");
        assertThat(StorageService.sanitizeOriginalName("a<b>c:d\"e|f?g*h.png")).isEqualTo("a_b_c_d_e_f_g_h.png");
        assertThat(StorageService.sanitizeOriginalName(null)).isEqualTo("unnamed");
        assertThat(StorageService.sanitizeOriginalName("   ")).isEqualTo("unnamed");
    }

    @Test
    @DisplayName("store() 拒绝伪装成 PNG 的 HTML（抛 415 对应的异常类型）")
    void storeRejectsHtmlDisguisedAsPng() {
        StorageService service = new StorageService("./target/test-uploads",
                "5MB", "image/png,image/jpeg,image/webp,image/gif");
        MockMultipartFile file = new MockMultipartFile("file", "fake.png", "image/png",
                "<!DOCTYPE html><html></html>".getBytes(StandardCharsets.UTF_8));

        assertThatThrownBy(() -> service.store(file))
                .isInstanceOf(FileStorageException.class)
                .satisfies(ex -> assertThat(((FileStorageException) ex).getStatus()).isEqualTo(415));
    }

    @Test
    @DisplayName("store() 对真实 PNG 生成 UUID 文件名，并且落在上传目录内")
    void storeWritesRealPng() {
        StorageService service = new StorageService("./target/test-uploads",
                "5MB", "image/png,image/jpeg,image/webp,image/gif");
        MockMultipartFile file = new MockMultipartFile("file", "../../截图.png", "image/png", png());

        var attachment = service.store(file);

        assertThat(attachment.getStoredName()).endsWith(".png").doesNotContain("..").doesNotContain("/");
        assertThat(attachment.getOriginalName()).isEqualTo("截图.png");
        assertThat(attachment.getContentType()).isEqualTo("image/png");
        assertThat(service.exists(attachment)).isTrue();
        // 落盘路径必须在上传目录内
        assertThat(service.resolveInsideRoot(attachment.getRelativePath()).startsWith(service.getRoot())).isTrue();
        service.delete(attachment);
    }

    @Test
    @DisplayName("相对路径解析拒绝任何越界写法")
    void rejectsPathTraversal() {
        StorageService service = new StorageService("./target/test-uploads",
                "5MB", "image/png");

        assertThatThrownBy(() -> service.resolveInsideRoot("../../etc/passwd"))
                .isInstanceOf(FileStorageException.class);
        assertThatThrownBy(() -> service.resolveInsideRoot("/absolute/path.png"))
                .isInstanceOf(FileStorageException.class);
        assertThatThrownBy(() -> service.resolveInsideRoot("C:/windows/system32/x.png"))
                .isInstanceOf(FileStorageException.class);
        assertThatThrownBy(() -> service.resolveInsideRoot(" "))
                .isInstanceOf(FileStorageException.class);
    }

    @Test
    @DisplayName("store() 复制中途 IOException：必须清掉本次写了一半的 target，目录里不留孤儿文件")
    void storeCleansPartialWriteOnFailure() throws Exception {
        Path dir = Files.createTempDirectory("ddlmate-storage-partial-");
        StorageService service = new StorageService(dir.toString(),
                "5MB", "image/png,image/jpeg,image/webp,image/gif");
        // 前 16 字节是合法 PNG 头（供魔数嗅探通过），整体超过一个复制缓冲区，
        // 保证 Files.copy 已经往 target 写了一部分之后才失败。
        byte[] payload = new byte[20_000];
        System.arraycopy(png(), 0, payload, 0, png().length);

        assertThatThrownBy(() -> service.store(new PartialWriteMultipartFile("partial.png", payload)))
                .isInstanceOf(FileStorageException.class);

        // 先确认真的走到了写盘阶段（target 的父目录已经建出来），否则"目录里没有文件"会变成空断言
        try (Stream<Path> entries = Files.walk(dir)) {
            assertThat(entries.filter(Files::isDirectory).count()).isGreaterThan(1L);
        }
        // 再确认失败后 target 的半截文件已被清掉
        try (Stream<Path> files = Files.walk(dir)) {
            assertThat(files.filter(Files::isRegularFile).toList()).isEmpty();
        }
    }

    /** 魔数嗅探时给得出合法 PNG 头，真正复制时写到一半抛 IOException 的上传文件。 */
    private static final class PartialWriteMultipartFile extends MockMultipartFile {

        private final byte[] payload;

        PartialWriteMultipartFile(String originalName, byte[] payload) {
            super("file", originalName, "image/png", payload);
            this.payload = payload;
        }

        @Override
        public InputStream getInputStream() {
            return new InputStream() {
                private int index;

                @Override
                public int read() throws IOException {
                    if (index < payload.length) {
                        return payload[index++] & 0xFF;
                    }
                    throw new IOException("模拟写盘中途磁盘失败");
                }
            };
        }
    }

    private static byte[] png() {
        return new byte[] {
                (byte) 0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,
                0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52
        };
    }

    private static byte[] riffWebp() {
        byte[] header = new byte[12];
        header[0] = 0x52;
        header[1] = 0x49;
        header[2] = 0x46;
        header[3] = 0x46;
        header[8] = 0x57;
        header[9] = 0x45;
        header[10] = 0x42;
        header[11] = 0x50;
        return header;
    }
}
