package com.ddlmate.service;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;
import org.springframework.util.unit.DataSize;
import org.springframework.web.multipart.MultipartFile;

import com.ddlmate.common.ErrorCodes;
import com.ddlmate.common.FileStorageException;
import com.ddlmate.common.InvalidRequestException;
import com.ddlmate.common.ResourceInUseException;
import com.ddlmate.common.ResourceNotFoundException;
import com.ddlmate.common.TimeZones;
import com.ddlmate.domain.Attachment;
import com.ddlmate.domain.Course;
import com.ddlmate.domain.Task;
import com.ddlmate.domain.TaskSource;
import com.ddlmate.domain.TaskStatus;
import com.ddlmate.domain.TaskType;
import com.ddlmate.repository.AttachmentRepository;
import com.ddlmate.repository.CourseRepository;
import com.ddlmate.repository.TaskRepository;
import com.ddlmate.repository.TaskSourceRepository;
import com.ddlmate.web.dto.AttachmentResponse;
import com.ddlmate.web.dto.NoticeImportRequest;
import com.ddlmate.web.dto.NoticeImportResponse;
import com.ddlmate.web.dto.TaskResponse;
import com.ddlmate.web.dto.TaskSourceResponse;

/**
 * 「通知截图 / 文字 → 待办」的批量落库服务。
 *
 * <p>这一层只负责**确认后的写入**：任务候选由前端在浏览器里用本地 OCR + 保守规则生成，
 * 后端不做语义抽取，也不访问外部模型。职责边界：</p>
 * <ol>
 *   <li><b>先整体校验，再写一个字节</b>：来源引用、图片下标、课程、类型、标题都在落盘前检查，
 *       任何一项不合法就 400/404/409，不会留下半个文件或半截数据；</li>
 *   <li><b>只写被引用的来源与图片</b>：没有任务引用的来源、来源没有引用的图片一律忽略并给出提示；</li>
 *   <li><b>复用现有存储安全策略</b>：一律走 {@link StorageService#store(MultipartFile)}（魔数嗅探、大小限制、
 *       服务器生成文件名、路径穿越防护），不绕过也不另写一套；</li>
 *   <li><b>事务与磁盘一致</b>：文件落盘先于数据库写入并逐条记录路径，
 *       事务一旦未提交（校验异常、约束冲突、提交阶段失败）就按记录把本次写盘的文件全部删掉。</li>
 * </ol>
 *
 * <p><b>重复候选与副本上限</b>：一次请求内只拒绝"语义字段与来源引用集合全部相同"的完全重复候选，
 * 不同课程或不同来源的同名同时间任务允许导入（<b>这不是跨请求幂等</b>）；实际写盘副本总字节超过
 * {@link #MAX_IMPORT_STORED_BYTES} 时，在落盘与写库之前整体 400 拒绝并提示分批导入。</p>
 *
 * <p><b>归属设计</b>：每个任务拥有自己的 {@link TaskSource} 行与 {@link Attachment} 行，
 * 并且每个 {@code (任务, 来源)} 组合在磁盘上各写一份<b>独立文件</b>、绑定到该任务自己的来源记录上。
 * 同一张上传图被多条任务引用时会复制多份（副本之间 id 与物理路径都不同），因此删除任意一条任务
 * （级联删除它的来源与附件）都不会动到别的任务的原图 —— 本机单人量级下用空间换"绝不误删他人附件"，
 * 比引入跨任务的附件共享与引用计数更稳、也更容易验证。</p>
 */
@Service
public class NoticeImportService {

    private static final Logger log = LoggerFactory.getLogger(NoticeImportService.class);

    /** 一次最多 8 张图（与前端选择上限、验收说明一致）。 */
    public static final int MAX_ATTACHMENTS = 8;

    /** 一次最多 12 个来源。 */
    public static final int MAX_SOURCES = 12;

    /** 一次最多 30 条任务候选。 */
    public static final int MAX_TASKS = 30;

    /**
     * 一次导入实际写盘的副本总字节上限：100 MiB。
     *
     * <p>同一张上传图被 N 个 {@code (任务, 来源)} 引用时就会写 N 份，所以"实际落盘字节"可能远大于
     * 请求体本身（{@code spring.servlet.multipart.max-request-size}）。这个上限约束的是磁盘副本总量，
     * 不是单张大小、也不是请求体大小；超过时在落盘与写库之前整体拒绝，提示用户分批导入。</p>
     */
    public static final long MAX_IMPORT_STORED_BYTES = 100L * 1024 * 1024;

    private final TaskRepository taskRepository;

    private final CourseRepository courseRepository;

    private final TaskSourceRepository sourceRepository;

    private final AttachmentRepository attachmentRepository;

    private final StorageService storageService;

    private final long maxRequestSizeBytes;

    private final QuotaService quotaService;

    public NoticeImportService(TaskRepository taskRepository, CourseRepository courseRepository,
            TaskSourceRepository sourceRepository, AttachmentRepository attachmentRepository,
            StorageService storageService, QuotaService quotaService,
            @Value("${spring.servlet.multipart.max-request-size:20MB}") String maxRequestSize) {
        this.quotaService = quotaService;
        this.taskRepository = taskRepository;
        this.courseRepository = courseRepository;
        this.sourceRepository = sourceRepository;
        this.attachmentRepository = attachmentRepository;
        this.storageService = storageService;
        this.maxRequestSizeBytes = DataSize.parse(maxRequestSize).toBytes();
    }

    public long maxFileSizeBytes() {
        return storageService.getMaxFileSizeBytes();
    }

    public long maxRequestSizeBytes() {
        return maxRequestSizeBytes;
    }

    @Transactional
    public NoticeImportResponse importNotices(NoticeImportRequest request, List<MultipartFile> files) {
        List<MultipartFile> uploads = files == null ? List.of() : files;
        List<String> notices = new ArrayList<>();
        quotaService.checkNewTasks(request.tasks().size());
        quotaService.checkNewFiles(uploads);

        // ---------- ① 请求级校验（不碰数据库、不碰磁盘） ----------
        if (request.tasks().isEmpty()) {
            throw new InvalidRequestException("tasks", "请至少勾选一条要保存的任务候选");
        }
        validateFiles(uploads);

        Map<String, NoticeImportRequest.SourceSpec> sourcesByRef = indexSources(request.sources());
        Map<Integer, NoticeImportRequest.AttachmentSpec> attachmentsByIndex = indexAttachments(
                request.attachments(), uploads);

        // ---------- ② 组装待写入对象（仍然没有落盘、没有写库） ----------
        Map<String, TaskType> taskTypes = new LinkedHashMap<>();
        Map<String, TaskStatus> taskStatuses = new LinkedHashMap<>();
        Map<String, Course> taskCourses = new LinkedHashMap<>();
        Map<String, String> taskTitles = new LinkedHashMap<>();
        // 第 i 条任务的来源绑定列表：每个绑定是 (taskIndex, sourceRef)，落盘与写库都以它为唯一定位键
        List<List<SourceBinding>> bindingsByTask = new ArrayList<>(request.tasks().size());
        // (taskIndex, sourceRef) → 该来源引用的图片下标；同一 sourceRef 被多条任务引用时会各有一条记录
        Map<BindingKey, List<Integer>> fileIndexesByBinding = new LinkedHashMap<>();
        Set<String> usedSourceRefs = new LinkedHashSet<>();
        Set<Integer> usedFileIndexes = new LinkedHashSet<>();
        Set<CandidateSignature> signatures = new LinkedHashSet<>();

        for (int i = 0; i < request.tasks().size(); i++) {
            NoticeImportRequest.TaskSpec spec = request.tasks().get(i);
            String key = "tasks[" + i + "]";
            if (spec == null) {
                throw new InvalidRequestException(key, "任务候选不能为空元素");
            }
            taskTitles.put(key, spec.title().trim());
            List<SourceBinding> bindings = requireSourceBindings(spec, i, sourcesByRef, fileIndexesByBinding,
                    attachmentsByIndex, key);
            bindingsByTask.add(bindings);
            for (SourceBinding binding : bindings) {
                usedSourceRefs.add(binding.sourceRef());
                usedFileIndexes.addAll(binding.fileIndexes());
            }
            // 类型/状态先规范化（缺省即默认值），课程取实体 id，再和来源一起进重复检测签名
            TaskType type = Enums.taskType(spec.type(), TaskType.HOMEWORK);
            TaskStatus status = Enums.taskStatus(spec.status(), TaskStatus.TODO);
            Course course = spec.courseId() == null ? null : requireCourse(spec.courseId());
            taskTypes.put(key, type);
            taskStatuses.put(key, status);
            taskCourses.put(key, course);
            if (!signatures.add(signature(spec, bindings, type, status, course))) {
                throw new ResourceInUseException("同一次导入里有完全重复的任务候选（标题、说明、课程、类型、状态、"
                        + "截止时间、提交要求/方式与来源都一致）：" + spec.title()
                        + "，请去掉重复项或修改其中一条；不同课程或不同来源的同名任务可以同时导入");
            }
        }

        // 副本总量上限：同一张上传图被 N 个 (任务, 来源) 引用就会写 N 份，实际落盘字节可能远大于
        // 请求体本身。这里在落盘与写库之前先算清楚，超出就整体 400 拒绝，提示用户分批导入。
        long storedBytes = totalStoredBytes(fileIndexesByBinding, uploads);
        if (storedBytes > MAX_IMPORT_STORED_BYTES) {
            throw new InvalidRequestException("attachments",
                    "本次导入会实际写盘 " + storedBytes + " 字节，超过单次上限 " + MAX_IMPORT_STORED_BYTES
                            + " 字节（同一张图被多条任务引用时，每条任务各存一份副本）；请分批导入："
                            + "减少同时勾选的任务数或来源数后重试");
        }

        Set<String> ignoredSources = new LinkedHashSet<>(sourcesByRef.keySet());
        ignoredSources.removeAll(usedSourceRefs);
        if (!ignoredSources.isEmpty()) {
            notices.add("有 " + ignoredSources.size() + " 个来源没有被任何任务候选引用，未写入数据库："
                    + String.join("、", ignoredSources));
        }
        Set<Integer> ignoredFiles = new LinkedHashSet<>(attachmentsByIndex.keySet());
        ignoredFiles.removeAll(usedFileIndexes);
        if (!ignoredFiles.isEmpty()) {
            notices.add("有 " + ignoredFiles.size() + " 张图片没有被选中的任务引用，未保存：" + ignoredFiles);
        }

        // ---------- ③ 落盘：每个 (任务, 来源) 各自一份独立文件 ----------
        // 同一张上传图被多条任务引用时，磁盘上会有多份副本：这是刻意的取舍 ——
        // 每条任务（及其来源、附件）完全自洽，删除任意一条任务只删自己的文件，
        // 不会因为共享路径而误删别的任务的原图。本机单人量级下存储开销可忽略。
        Map<BindingKey, List<Attachment>> storedByBinding = new LinkedHashMap<>();
        List<String> writtenPaths = new ArrayList<>();
        List<String> writtenNames = new ArrayList<>();
        try {
            for (int i = 0; i < bindingsByTask.size(); i++) {
                for (SourceBinding binding : bindingsByTask.get(i)) {
                    List<Attachment> stored = new ArrayList<>();
                    for (Integer fileIndex : binding.fileIndexes()) {
                        Attachment attachment = storageService.store(uploads.get(fileIndex));
                        writtenPaths.add(attachment.getRelativePath());
                        writtenNames.add(attachment.getOriginalName());
                        stored.add(attachment);
                    }
                    storedByBinding.put(new BindingKey(i, binding.sourceRef()), stored);
                }
            }
        } catch (RuntimeException ex) {
            // 本次调用写过的文件全部清理，不再尝试写库。
            // 触发失败的那一个由 StorageService.store 自己清掉部分写入的 target。
            deleteFilesQuietly(writtenPaths, writtenNames);
            throw ex;
        }
        // 事务最终没有提交（含提交阶段失败）时，同样按记录清理磁盘文件
        registerRollbackCleanup(writtenPaths, writtenNames);

        // ---------- ④ 写库：任务 → 自己的来源 → 自己的附件 ----------
        List<Task> savedTasks = new ArrayList<>();
        List<Attachment> savedAttachments = new ArrayList<>();
        for (int i = 0; i < request.tasks().size(); i++) {
            NoticeImportRequest.TaskSpec spec = request.tasks().get(i);
            String key = "tasks[" + i + "]";
            Task task = new Task(taskTitles.get(key));
            task.setDescription(blankToNull(spec.description()));
            task.setCourse(taskCourses.get(key));
            task.setType(taskTypes.get(key));
            task.setStatus(taskStatuses.get(key));
            task.setDeadline(spec.deadline());
            task.setSubmitRequirement(blankToNull(spec.submitRequirement()));
            task.setSubmitMethod(blankToNull(spec.submitMethod()));
            if (task.getStatus().isClosed()) {
                task.setCompletedAt(TimeZones.now());
            }
            Task savedTask = taskRepository.save(task);
            savedTasks.add(savedTask);

            for (SourceBinding binding : bindingsByTask.get(i)) {
                NoticeImportRequest.SourceSpec sourceSpec = sourcesByRef.get(binding.sourceRef());
                TaskSource source = new TaskSource(sourceSpec.sourceName().trim(),
                        blankToNull(sourceSpec.rawText()));
                source.setSourceType(blankToNull(sourceSpec.sourceType()));
                source.setCapturedAt(sourceSpec.capturedAt() == null ? TimeZones.now() : sourceSpec.capturedAt());
                source.setTask(savedTask);
                TaskSource savedSource = sourceRepository.save(source);

                for (Attachment stored : storedByBinding.getOrDefault(
                        new BindingKey(i, binding.sourceRef()), List.of())) {
                    // 落盘时已按 (taskIndex, sourceRef) 各写一份独立文件；这里 1:1 新建一条 Attachment 行，
                    // 绑定到该任务自己的来源。不再复用别的来源的实体、也不共用磁盘路径。
                    Attachment row = new Attachment(stored.getStoredName(), stored.getOriginalName(),
                            stored.getContentType(), stored.getSizeBytes(), stored.getRelativePath());
                    row.setTaskSource(savedSource);
                    Attachment savedAttachment = attachmentRepository.save(row);
                    savedSource.getAttachments().add(savedAttachment);
                    savedAttachments.add(savedAttachment);
                }
            }
        }

        // flush 一次：让约束冲突发生在这里（此时磁盘清理回调还来得及生效），而不是等到提交阶段
        taskRepository.flush();
        attachmentRepository.flush();

        // ---------- ⑤ 组装响应 ----------
        List<TaskResponse> taskResponses = new ArrayList<>(savedTasks.size());
        List<TaskSourceResponse> sourceResponses = new ArrayList<>();
        for (Task task : savedTasks) {
            List<TaskSource> sources = sourceRepository.findByTaskIdWithAttachments(task.getId());
            taskResponses.add(ApiMapper.task(task, sources.size(), flatten(sources)));
            for (TaskSource source : sources) {
                sourceResponses.add(ApiMapper.source(source));
            }
        }
        List<AttachmentResponse> attachmentResponses = new ArrayList<>(savedAttachments.size());
        for (Attachment attachment : savedAttachments) {
            attachmentResponses.add(ApiMapper.attachment(attachment));
        }

        log.info("通知导入完成：任务 {} 条，来源 {} 条，图片 {} 张", savedTasks.size(), sourceResponses.size(),
                attachmentResponses.size());
        return new NoticeImportResponse(
                taskResponses.size(),
                sourceResponses.size(),
                attachmentResponses.size(),
                savedTasks.stream().map(Task::getId).toList(),
                taskResponses,
                sourceResponses,
                attachmentResponses,
                notices);
    }

    // ------------------------------------------------------------------ 计划模型

    /**
     * 一条任务内某个来源的绑定：来源标识 + 它引用的图片下标（已校验、已去重）。
     *
     * <p>{@code fileIndexes} 里的下标对应 multipart 的 {@code files} 顺序，允许为空（纯文字通知）。</p>
     */
    private record SourceBinding(String sourceRef, List<Integer> fileIndexes) {
    }

    /**
     * 落盘与写库的唯一定位键：第几条任务 + 哪个来源。
     *
     * <p>用 {@code (taskIndex, sourceRef)} 而不是只用 {@code sourceRef} 做键，是"同一张上传图被多任务
     * 引用时各写各的"这一语义的落点：同一条任务不会重复引用同一个来源，因此该键在请求内唯一。</p>
     */
    private record BindingKey(int taskIndex, String sourceRef) {
    }

    /**
     * 一次请求内判定"完全重复候选"用的语义签名。
     *
     * <p>用 record 的结构相等而不是拼接字符串，避免分隔符恰好在字段值里造成误判；
     * {@code sourceRefs} 必须已排序，List 的相等才对引用顺序不敏感。</p>
     */
    private record CandidateSignature(String title, String description, Long courseId, String type, String status,
            String deadlineInstant, String submitRequirement, String submitMethod, List<String> sourceRefs) {
    }

    // ------------------------------------------------------------------ 校验

    private Map<String, NoticeImportRequest.SourceSpec> indexSources(
            List<NoticeImportRequest.SourceSpec> sources) {
        if (sources.size() > MAX_SOURCES) {
            throw new InvalidRequestException("sources",
                    "一次最多 " + MAX_SOURCES + " 个来源，实际 " + sources.size() + " 个");
        }
        Map<String, NoticeImportRequest.SourceSpec> byRef = new LinkedHashMap<>();
        for (int i = 0; i < sources.size(); i++) {
            NoticeImportRequest.SourceSpec spec = sources.get(i);
            if (spec == null) {
                throw new InvalidRequestException("sources[" + i + "]", "来源不能为空元素");
            }
            String ref = spec.sourceRef() == null ? "" : spec.sourceRef().trim();
            if (ref.isEmpty()) {
                throw new InvalidRequestException("sources[" + i + "].sourceRef", "来源标识不能为空");
            }
            if (byRef.putIfAbsent(ref, spec) != null) {
                throw new InvalidRequestException("sources[" + i + "].sourceRef", "来源标识重复：" + ref);
            }
        }
        return byRef;
    }

    private Map<Integer, NoticeImportRequest.AttachmentSpec> indexAttachments(
            List<NoticeImportRequest.AttachmentSpec> attachments, List<MultipartFile> uploads) {
        Map<Integer, NoticeImportRequest.AttachmentSpec> byIndex = new LinkedHashMap<>();
        if (attachments == null) {
            return byIndex;
        }
        for (int i = 0; i < attachments.size(); i++) {
            NoticeImportRequest.AttachmentSpec spec = attachments.get(i);
            if (spec == null) {
                throw new InvalidRequestException("attachments[" + i + "]", "图片元数据不能为空元素");
            }
            Integer fileIndex = spec.fileIndex();
            if (fileIndex == null || fileIndex < 0 || fileIndex >= uploads.size()) {
                throw new InvalidRequestException("attachments[" + i + "].fileIndex",
                        "图片下标越界：" + fileIndex + "（本次请求共 " + uploads.size() + " 张图片）");
            }
            if (byIndex.putIfAbsent(fileIndex, spec) != null) {
                throw new InvalidRequestException("attachments[" + i + "].fileIndex",
                        "同一张图片被声明了两次（下标 " + fileIndex + "）");
            }
        }
        return byIndex;
    }

    /**
     * 校验任务的来源引用，并顺带校验/登记每个来源引用的图片下标。
     *
     * <p>{@code fileIndexesByBinding} 是"来源 → 图片下标"的唯一定义处，键是
     * {@link BindingKey}(taskIndex, sourceRef)：同一个 sourceRef 被多条任务引用时会各有一条记录，
     * 后面落盘与写库都按这个键各写各的副本，绝不跨任务共享附件实体或磁盘路径。</p>
     */
    private List<SourceBinding> requireSourceBindings(NoticeImportRequest.TaskSpec spec, int taskIndex,
            Map<String, NoticeImportRequest.SourceSpec> sourcesByRef,
            Map<BindingKey, List<Integer>> fileIndexesByBinding,
            Map<Integer, NoticeImportRequest.AttachmentSpec> attachmentsByIndex, String key) {
        List<String> refs = spec.sourceRefs();
        if (refs == null || refs.isEmpty()) {
            throw new InvalidRequestException(key + ".sourceRefs", "任务必须关联至少一个来源");
        }
        List<SourceBinding> bindings = new ArrayList<>();
        for (String raw : refs) {
            String ref = raw == null ? "" : raw.trim();
            if (ref.isEmpty()) {
                throw new InvalidRequestException(key + ".sourceRefs", "来源标识不能为空");
            }
            if (!sourcesByRef.containsKey(ref)) {
                throw new InvalidRequestException(key + ".sourceRefs", "引用了不存在的来源：" + ref);
            }
            BindingKey bindingKey = new BindingKey(taskIndex, ref);
            if (fileIndexesByBinding.containsKey(bindingKey)) {
                throw new InvalidRequestException(key + ".sourceRefs", "重复引用了同一个来源：" + ref);
            }
            List<Integer> indexes = validateAttachmentIndexes(ref, sourcesByRef.get(ref), attachmentsByIndex);
            fileIndexesByBinding.put(bindingKey, indexes);
            bindings.add(new SourceBinding(ref, indexes));
        }
        return bindings;
    }

    /** 校验一个来源引用的图片下标：必须已在 attachments 里声明、不越界、不重复。 */
    private List<Integer> validateAttachmentIndexes(String sourceRef, NoticeImportRequest.SourceSpec spec,
            Map<Integer, NoticeImportRequest.AttachmentSpec> attachmentsByIndex) {
        List<Integer> indexes = new ArrayList<>();
        String field = "sources[" + sourceRef + "].attachmentIndexes";
        for (Integer index : spec.attachmentIndexes() == null ? List.<Integer>of() : spec.attachmentIndexes()) {
            if (index == null) {
                throw new InvalidRequestException(field, "来源 " + sourceRef + " 的图片下标不能为空");
            }
            if (!attachmentsByIndex.containsKey(index)) {
                throw new InvalidRequestException(field,
                        "来源 " + sourceRef + " 引用了不存在的图片下标 " + index);
            }
            if (indexes.contains(index)) {
                throw new InvalidRequestException(field,
                        "来源 " + sourceRef + " 重复引用了同一张图片（下标 " + index + "）");
            }
            indexes.add(index);
        }
        return indexes;
    }

    /** 图片本身的数量与大小校验：都在落盘之前做，避免"先写一半再报错"。 */
    private void validateFiles(List<MultipartFile> uploads) {
        if (uploads.size() > MAX_ATTACHMENTS) {
            throw new InvalidRequestException("files",
                    "一次最多选择 " + MAX_ATTACHMENTS + " 张图片，实际 " + uploads.size() + " 张");
        }
        long total = 0;
        for (int i = 0; i < uploads.size(); i++) {
            MultipartFile file = uploads.get(i);
            if (file == null || file.isEmpty()) {
                throw new InvalidRequestException("files[" + i + "]", "第 " + (i + 1) + " 张图片是空文件");
            }
            if (file.getSize() > storageService.getMaxFileSizeBytes()) {
                throw new FileStorageException(413, ErrorCodes.FILE_TOO_LARGE,
                        "第 " + (i + 1) + " 张图片过大：" + file.getSize() + " 字节，单张上限 "
                                + storageService.getMaxFileSizeBytes() + " 字节");
            }
            total += file.getSize();
        }
        if (total > maxRequestSizeBytes) {
            throw new FileStorageException(413, ErrorCodes.FILE_TOO_LARGE,
                    "图片总量过大：" + total + " 字节，单次请求上限 " + maxRequestSizeBytes + " 字节");
        }
    }

    private Course requireCourse(Long courseId) {
        return courseRepository.findById(courseId)
                .orElseThrow(() -> new ResourceNotFoundException("课程", courseId));
    }

    /**
     * 请求内重复检测用的签名：只包含语义字段与来源引用集合。
     *
     * <p>刻意不算"请求里的下标或书写顺序"：{@code sourceRefs} 用排序后的集合表示，所以同一条候选
     * 换个来源顺序仍算重复。反过来，课程不同、来源不同、说明/提交要求/提交方式不同、类型或状态
     * （含缺省值规范化后）不同都<b>不算</b>重复 —— 不同课程或不同原通知里的同名同时间作业本来就是
     * 两件事，不能被 409 挡掉。deadline 按时刻比较，同一时刻的不同时区写法算相同。</p>
     *
     * <p><b>这个签名只在一次请求内部有效，不是跨请求幂等</b>：同样的候选分两次请求提交仍会各写一份，
     * 真正的防重复依赖前端禁用重复点击与用户确认。</p>
     */
    private CandidateSignature signature(NoticeImportRequest.TaskSpec spec, List<SourceBinding> bindings,
            TaskType type, TaskStatus status, Course course) {
        return new CandidateSignature(
                spec.title().trim(),
                blankToNull(spec.description()),
                course == null ? null : course.getId(),
                type.name(),
                status.name(),
                spec.deadline() == null ? null : spec.deadline().toInstant().toString(),
                blankToNull(spec.submitRequirement()),
                blankToNull(spec.submitMethod()),
                bindings.stream().map(SourceBinding::sourceRef).sorted().toList());
    }

    /** 本次导入实际会写盘的副本总字节数：按每个 (任务, 来源) 绑定引用的文件 size 累加。 */
    private static long totalStoredBytes(Map<BindingKey, List<Integer>> fileIndexesByBinding,
            List<MultipartFile> uploads) {
        long total = 0;
        for (List<Integer> indexes : fileIndexesByBinding.values()) {
            for (Integer fileIndex : indexes) {
                total += uploads.get(fileIndex).getSize();
            }
        }
        return total;
    }

    // ------------------------------------------------------------------ 清理

    /** 事务回滚/未提交时清理本次已写入的磁盘文件（按落盘记录，不依赖数据库状态）。 */
    private void registerRollbackCleanup(List<String> relativePaths, List<String> names) {
        if (relativePaths.isEmpty() || !TransactionSynchronizationManager.isSynchronizationActive()) {
            return;
        }
        List<String> paths = List.copyOf(relativePaths);
        List<String> labels = List.copyOf(names);
        TransactionSynchronizationManager.registerSynchronization(new TransactionSynchronization() {
            @Override
            public void afterCompletion(int status) {
                if (status != TransactionSynchronization.STATUS_COMMITTED) {
                    log.warn("通知导入事务未提交（status={}），清理本次写入的 {} 个附件文件", status, paths.size());
                    deleteFilesQuietly(paths, labels);
                }
            }
        });
    }

    private void deleteFilesQuietly(List<String> relativePaths, List<String> names) {
        for (int i = 0; i < relativePaths.size(); i++) {
            log.warn("清理通知导入的附件文件：{}（原始名 {}）", relativePaths.get(i), names.get(i));
            storageService.deleteByRelativePath(relativePaths.get(i));
        }
    }

    private static String blankToNull(String value) {
        if (value == null) {
            return null;
        }
        String trimmed = value.trim();
        return trimmed.isEmpty() ? null : trimmed;
    }

    private List<Attachment> flatten(List<TaskSource> sources) {
        List<Attachment> attachments = new ArrayList<>();
        for (TaskSource source : sources) {
            attachments.addAll(source.getAttachments());
        }
        return attachments;
    }

    /** 供控制器与元数据接口使用：当前的真实上限。 */
    public Map<String, Long> limits() {
        Map<String, Long> limits = new HashMap<>();
        limits.put("maxFileSizeBytes", storageService.getMaxFileSizeBytes());
        limits.put("maxRequestSizeBytes", maxRequestSizeBytes);
        limits.put("maxAttachments", (long) MAX_ATTACHMENTS);
        limits.put("maxSources", (long) MAX_SOURCES);
        limits.put("maxTasks", (long) MAX_TASKS);
        limits.put("maxImportStoredBytes", MAX_IMPORT_STORED_BYTES);
        return limits;
    }
}
