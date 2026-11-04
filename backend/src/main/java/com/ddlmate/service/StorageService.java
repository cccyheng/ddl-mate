package com.ddlmate.service;

import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.nio.file.StandardCopyOption;
import java.time.LocalDate;
import java.util.Arrays;
import java.util.LinkedHashSet;
import java.util.Locale;
import java.util.Set;
import java.util.UUID;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.core.io.Resource;
import org.springframework.core.io.UrlResource;
import org.springframework.stereotype.Service;
import org.springframework.util.unit.DataSize;
import org.springframework.web.multipart.MultipartFile;

import com.ddlmate.common.FileStorageException;
import com.ddlmate.domain.Attachment;

import jakarta.annotation.PostConstruct;

/**
 * 附件落盘服务。
 *
 * <p>安全要点：</p>
 * <ol>
 *   <li>只接受图片类型，且用文件头魔数嗅探，不只信任客户端传来的 Content-Type；</li>
 *   <li>限制单文件大小；</li>
 *   <li>文件名一律由服务器生成（UUID + 由类型决定的扩展名），用户提供的名字只做展示；</li>
 *   <li>读取时把上传目录 normalize + 强制以绝对路径开头校验，阻止 ../ 路径穿越。</li>
 * </ol>
 */
@Service
public class StorageService {

    private static final Logger log = LoggerFactory.getLogger(StorageService.class);

    private final Path root;

    private final long maxFileSizeBytes;

    private final Set<String> allowedContentTypes;

    public StorageService(
            @Value("${ddlmate.storage.upload-dir:./data/uploads}") String uploadDir,
            @Value("${ddlmate.storage.max-file-size:5MB}") String maxFileSize,
            @Value("${ddlmate.storage.allowed-content-types:image/png,image/jpeg,image/webp,image/gif}") String allowedTypes) {
        this.root = Paths.get(uploadDir).toAbsolutePath().normalize();
        this.maxFileSizeBytes = DataSize.parse(maxFileSize).toBytes();
        this.allowedContentTypes = new LinkedHashSet<>(Arrays.stream(allowedTypes.split(","))
                .map(String::trim)
                .filter(s -> !s.isEmpty())
                .map(s -> s.toLowerCase(Locale.ROOT))
                .toList());
    }

    @PostConstruct
    void init() {
        try {
            Files.createDirectories(root);
            log.info("附件上传目录就绪：{}（单文件上限 {} 字节，允许类型 {}）", root, maxFileSizeBytes, allowedContentTypes);
        } catch (IOException ex) {
            throw new IllegalStateException("无法创建上传目录：" + root, ex);
        }
    }

    public Path getRoot() {
        return root;
    }

    public long getMaxFileSizeBytes() {
        return maxFileSizeBytes;
    }

    /** 校验并保存文件，返回可持久化的附件元数据。 */
    public Attachment store(MultipartFile file) {
        if (file == null || file.isEmpty()) {
            throw new FileStorageException(400, com.ddlmate.common.ErrorCodes.INVALID_ARGUMENT, "上传文件为空");
        }
        if (file.getSize() > maxFileSizeBytes) {
            throw FileStorageException.tooLarge(file.getSize(), maxFileSizeBytes);
        }

        String originalName = sanitizeOriginalName(file.getOriginalFilename());
        byte[] header = readHeader(file);
        // 只信魔数：识别不出的内容一律 415，客户端声明的 Content-Type 不参与判定
        String detectedType = requireAllowedImageType(header, file.getContentType());

        String extension = extensionFor(detectedType, originalName);
        String storedName = UUID.randomUUID().toString().replace("-", "") + extension;
        String relativePath = LocalDate.now().getYear() + "/" + String.format("%02d", LocalDate.now().getMonthValue())
                + "/" + storedName;

        Path target = resolveInsideRoot(relativePath);
        try {
            Files.createDirectories(target.getParent());
            try (InputStream in = file.getInputStream()) {
                Files.copy(in, target, StandardCopyOption.REPLACE_EXISTING);
            }
        } catch (IOException ex) {
            // 复制到一半失败会在磁盘上留下半截 target（此时还没有任何数据库记录引用它）：
            // 必须先清掉本次写入的 target，再抛出，避免产生孤儿文件。
            cleanupPartiallyWrittenTarget(target, relativePath);
            throw FileStorageException.ioFailure(ex.getMessage());
        }

        log.debug("附件已保存：{}（{} 字节，原始名 {}）", relativePath, file.getSize(), originalName);
        return new Attachment(storedName, originalName, detectedType, file.getSize(), relativePath.replace('\\', '/'));
    }

    /**
     * 清理 {@link #store(MultipartFile)} 部分写盘失败后留下的 target。
     *
     * <p>只删本次调用自己解析出来的那个文件；删除失败只记日志，不掩盖原始的存储异常。</p>
     */
    private void cleanupPartiallyWrittenTarget(Path target, String relativePath) {
        try {
            if (Files.deleteIfExists(target)) {
                log.warn("附件写入失败，已清理本次的部分文件：{}", relativePath);
            }
        } catch (IOException | RuntimeException cleanupEx) {
            log.warn("附件写入失败，清理部分文件也失败：{}（{}）", relativePath, cleanupEx.getMessage());
        }
    }

    /** 读取附件内容，返回 Spring 的 Resource。文件丢失时抛 404。 */
    public Resource loadAsResource(Attachment attachment) {
        Path path = resolveInsideRoot(attachment.getRelativePath());
        if (!Files.exists(path)) {
            log.warn("附件记录存在但磁盘文件缺失：{}", attachment.getRelativePath());
            throw new com.ddlmate.common.ResourceNotFoundException("附件文件", attachment.getId());
        }
        try {
            return new UrlResource(path.toUri());
        } catch (java.net.MalformedURLException ex) {
            throw FileStorageException.ioFailure(ex.getMessage());
        }
    }

    public boolean exists(Attachment attachment) {
        return Files.exists(resolveInsideRoot(attachment.getRelativePath()));
    }

    /** 删除磁盘文件；文件已不存在也算成功（幂等）。 */
    public void delete(Attachment attachment) {
        if (attachment == null) {
            return;
        }
        deleteByRelativePath(attachment.getRelativePath());
    }

    /** 按相对路径删文件；路径非法或删除失败只记日志，不抛异常（用于清理场景）。 */
    public void deleteByRelativePath(String relativePath) {
        if (relativePath == null || relativePath.isBlank()) {
            return;
        }
        try {
            Files.deleteIfExists(resolveInsideRoot(relativePath));
        } catch (IOException | RuntimeException ex) {
            log.warn("删除附件文件失败：{}（{}）", relativePath, ex.getMessage());
        }
    }

    /** 清理时使用：删除单张附件文件且不抛异常。 */
    public void deleteQuietly(Attachment attachment) {
        if (attachment == null) {
            return;
        }
        deleteByRelativePath(attachment.getRelativePath());
    }

    /** 把用户提供的相对路径解析到上传目录内，任何越界都拒绝。 */
    public Path resolveInsideRoot(String relativePath) {
        if (relativePath == null || relativePath.isBlank()) {
            throw FileStorageException.invalidName(String.valueOf(relativePath));
        }
        String normalized = relativePath.replace('\\', '/');
        if (normalized.contains("..") || normalized.startsWith("/") || normalized.contains(":")) {
            throw FileStorageException.invalidName(relativePath);
        }
        Path candidate = root.resolve(normalized).normalize();
        if (!candidate.startsWith(root)) {
            throw FileStorageException.invalidName(relativePath);
        }
        return candidate;
    }

    /** 只保留文件名部分，去掉任何目录信息，再过滤非法字符。 */
    static String sanitizeOriginalName(String raw) {
        String name = raw == null ? "" : raw;
        name = name.replace('\\', '/');
        int slash = name.lastIndexOf('/');
        if (slash >= 0) {
            name = name.substring(slash + 1);
        }
        name = name.replaceAll("[\\p{Cntrl}]", "").trim();
        name = name.replaceAll("[<>:\"|?*]", "_");
        if (name.isEmpty() || name.equals(".") || name.equals("..")) {
            return "unnamed";
        }
        return name.length() > 255 ? name.substring(name.length() - 255) : name;
    }

    private byte[] readHeader(MultipartFile file) {
        try (InputStream in = file.getInputStream()) {
            return in.readNBytes(12);
        } catch (IOException ex) {
            throw FileStorageException.ioFailure(ex.getMessage());
        }
    }

    /**
     * 用文件头魔数判断真实类型。
     *
     * <p><b>只认魔数，不看客户端声明的 Content-Type</b>：识别不出就返回 {@code null}，
     * 由调用方按"不支持的媒体类型"拒绝。这样 HTML/文本改个后缀或改个 Content-Type 也进不来。</p>
     */
    static String detectContentType(byte[] header) {
        if (header == null || header.length < 4) {
            return null;
        }
        int b0 = header[0] & 0xFF;
        int b1 = header[1] & 0xFF;
        int b2 = header[2] & 0xFF;
        int b3 = header[3] & 0xFF;

        // PNG：完整 8 字节签名 89 50 4E 47 0D 0A 1A 0A
        if (header.length >= 8
                && b0 == 0x89 && b1 == 0x50 && b2 == 0x4E && b3 == 0x47
                && (header[4] & 0xFF) == 0x0D && (header[5] & 0xFF) == 0x0A
                && (header[6] & 0xFF) == 0x1A && (header[7] & 0xFF) == 0x0A) {
            return "image/png";
        }
        // JPEG：FF D8 FF
        if (b0 == 0xFF && b1 == 0xD8 && b2 == 0xFF) {
            return "image/jpeg";
        }
        // GIF：GIF87a / GIF89a
        if (b0 == 0x47 && b1 == 0x49 && b2 == 0x46 && b3 == 0x38
                && header.length >= 6
                && ((header[4] & 0xFF) == 0x37 || (header[4] & 0xFF) == 0x39)
                && (header[5] & 0xFF) == 0x61) {
            return "image/gif";
        }
        // WebP：RIFF....WEBP
        if (header.length >= 12
                && b0 == 0x52 && b1 == 0x49 && b2 == 0x46 && b3 == 0x46
                && (header[8] & 0xFF) == 0x57 && (header[9] & 0xFF) == 0x45
                && (header[10] & 0xFF) == 0x42 && (header[11] & 0xFF) == 0x50) {
            return "image/webp";
        }
        return null;
    }

    /** 校验魔数结果必须落在允许列表内，否则 415。 */
    private String requireAllowedImageType(byte[] header, String declaredType) {
        String detected = detectContentType(header);
        if (detected == null) {
            throw FileStorageException.unsupportedType(
                    "文件内容不是可识别的图片（客户端声明为 " + (declaredType == null ? "未知" : declaredType) + "）");
        }
        if (!allowedContentTypes.contains(detected)) {
            throw FileStorageException.unsupportedType(detected);
        }
        return detected;
    }

    static String extensionFor(String contentType, String originalName) {
        return switch (contentType) {
            case "image/png" -> ".png";
            case "image/jpeg" -> ".jpg";
            case "image/gif" -> ".gif";
            case "image/webp" -> ".webp";
            default -> {
                int dot = originalName == null ? -1 : originalName.lastIndexOf('.');
                if (dot >= 0 && dot < originalName.length() - 1) {
                    String ext = originalName.substring(dot).toLowerCase(Locale.ROOT);
                    yield ext.matches("\\.[a-z0-9]{1,8}") ? ext : ".bin";
                }
                yield ".bin";
            }
        };
    }
}
