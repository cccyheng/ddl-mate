package com.ddlmate.service;

import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.EnumMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.Function;
import java.util.stream.Collectors;

import org.springframework.data.jpa.domain.Specification;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import com.ddlmate.common.InvalidRequestException;
import com.ddlmate.common.ResourceNotFoundException;
import com.ddlmate.common.TimeZones;
import com.ddlmate.domain.Attachment;
import com.ddlmate.domain.Course;
import com.ddlmate.domain.Task;
import com.ddlmate.domain.TaskPriority;
import com.ddlmate.domain.TaskSource;
import com.ddlmate.domain.TaskStatus;
import com.ddlmate.domain.TaskType;
import com.ddlmate.repository.CourseRepository;
import com.ddlmate.repository.TaskRepository;
import com.ddlmate.repository.TaskSourceRepository;
import com.ddlmate.web.dto.CalendarMonthResponse;
import com.ddlmate.web.dto.PageResponse;
import com.ddlmate.web.dto.TaskPatchRequest;
import com.ddlmate.web.dto.TaskRequest;
import com.ddlmate.web.dto.TaskResponse;
import com.ddlmate.web.dto.TaskStatsResponse;

import jakarta.persistence.criteria.JoinType;
import jakarta.persistence.criteria.Predicate;

@Service
public class TaskService {

    private final TaskRepository taskRepository;

    private final CourseRepository courseRepository;

    private final TaskSourceRepository sourceRepository;

    private final StorageService storageService;

    private final QuerySupport querySupport;

    public TaskService(TaskRepository taskRepository, CourseRepository courseRepository,
            TaskSourceRepository sourceRepository, StorageService storageService, QuerySupport querySupport) {
        this.taskRepository = taskRepository;
        this.courseRepository = courseRepository;
        this.sourceRepository = sourceRepository;
        this.storageService = storageService;
        this.querySupport = querySupport;
    }

    // ------------------------------------------------------------------ 查询

    @Transactional(readOnly = true)
    public PageResponse<TaskResponse> search(TaskQuery query) {
        int page = querySupport.normalizePage(query.page());
        int size = querySupport.normalizeSize(query.size());
        // 排序字段先做白名单校验（非法字段继续返回 400）
        querySupport.taskSort(query.sort(), query.direction());

        // 过滤在数据库完成；排序与分页在内存完成。
        // 原因：Criteria 查询不支持 NULLS LAST，而"没有 DDL 的任务排在最后"需要空值偏好；
        // 内存排序能让 H2 与 MySQL 行为完全一致，逻辑也更直观（数据规模为本机单人量级）。
        List<Task> matched = new ArrayList<>(taskRepository.findAll(buildSpec(query, TimeZones.now())));
        matched.sort(taskComparator(query.sort(), query.direction()));

        long total = matched.size();
        int totalPages = size < 1 ? 0 : (int) Math.ceil((double) total / size);
        int fromIndex = Math.min(page * size, matched.size());
        int toIndex = Math.min(fromIndex + size, matched.size());
        List<Task> pageContent = matched.subList(fromIndex, toIndex);

        return new PageResponse<>(hydrate(pageContent, sourceRepository.findByTaskIdInWithAttachments(
                pageContent.stream().map(Task::getId).toList())), page, size, total, totalPages);
    }

    /**
     * DDL 列表：列出**有截止时间**的任务，默认按 DDL 升序（逾期/最近的在最前），
     * 默认不含已完成/已归档；{@code includeDone=true} 时包含它们。
     *
     * <p>排序语义固定为：</p>
     * <ul>
     *   <li>{@code sort=deadline}（默认）：按截止时间，{@code direction=asc|desc} 生效；</li>
     *   <li>{@code sort=priority}：按优先级从高到低，同优先级再按 DDL 升序；</li>
     *   <li>{@code sort=course}：按课程代码，再按 DDL 升序。</li>
     * </ul>
     *
     * <p>为了 H2/MySQL 行为一致，这里统一在内存里过滤+排序（列表本身只含"有 DDL"的任务，
     * 规模可控），不再使用 200 条的隐式上限。</p>
     */
    @Transactional(readOnly = true)
    public List<TaskResponse> deadlines(String sort, String direction, Long courseId, boolean includeDone) {
        String key = sort == null || sort.isBlank() ? "deadline" : sort.trim().toLowerCase(java.util.Locale.ROOT);
        // 白名单校验：非法排序字段仍然返回 400，而不是静默忽略
        querySupport.taskSort(key, direction);

        List<Task> tasks = new ArrayList<>(courseId == null
                ? taskRepository.findAllWithDeadline()
                : taskRepository.findWithDeadlineByCourse(courseId));
        tasks.removeIf(task -> task.getDeadline() == null);
        if (!includeDone) {
            tasks.removeIf(task -> task.getStatus().isClosed());
        }

        boolean desc = "desc".equalsIgnoreCase(direction);
        tasks.sort(taskComparator(key, direction));
        // 列表本身已保证都有 deadline；这里不依赖 nullsLast，因此 desc 与 asc 语义都明确
        if (desc && "deadline".equals(key)) {
            tasks.sort(java.util.Comparator.comparing(Task::getDeadline).reversed()
                    .thenComparing(Task::getPriority, java.util.Comparator.reverseOrder())
                    .thenComparing(Task::getId));
        }
        return hydrate(tasks);
    }

    @Transactional(readOnly = true)
    public List<TaskResponse> today() {
        ZoneId zone = TimeZones.zone();
        LocalDate today = LocalDate.now(zone);
        OffsetDateTime dayStart = today.atStartOfDay(zone).toOffsetDateTime();
        OffsetDateTime nextDayStart = today.plusDays(1).atStartOfDay(zone).toOffsetDateTime();
        OffsetDateTime now = TimeZones.now();

        Map<Long, Task> merged = new LinkedHashMap<>();
        for (Task task : taskRepository.findInWindow(dayStart, nextDayStart)) {
            if (!task.getStatus().isClosed()) {
                merged.put(task.getId(), task);
            }
        }
        for (Task task : taskRepository.findOverdueOpen(now)) {
            merged.putIfAbsent(task.getId(), task);
        }
        return hydrate(new ArrayList<>(merged.values()));
    }

    @Transactional(readOnly = true)
    public List<TaskResponse> byDate(LocalDate date) {
        ZoneId zone = TimeZones.zone();
        OffsetDateTime from = date.atStartOfDay(zone).toOffsetDateTime();
        OffsetDateTime to = date.plusDays(1).atStartOfDay(zone).toOffsetDateTime();
        return hydrate(taskRepository.findInWindow(from, to));
    }

    @Transactional(readOnly = true)
    public CalendarMonthResponse calendar(int year, int month) {
        if (month < 1 || month > 12) {
            throw new InvalidRequestException("month", "月份取值范围是 1-12");
        }
        ZoneId zone = TimeZones.zone();
        LocalDate first = LocalDate.of(year, month, 1);
        LocalDate lastExclusive = first.plusMonths(1);
        OffsetDateTime from = first.atStartOfDay(zone).toOffsetDateTime();
        OffsetDateTime to = lastExclusive.atStartOfDay(zone).toOffsetDateTime();

        List<Task> tasks = taskRepository.findInWindow(from, to);
        Map<LocalDate, List<Task>> grouped = new LinkedHashMap<>();
        for (Task task : tasks) {
            LocalDate date = task.getDeadline().atZoneSameInstant(zone).toLocalDate();
            grouped.computeIfAbsent(date, key -> new ArrayList<>()).add(task);
        }

        List<CalendarMonthResponse.DayTasks> days = new ArrayList<>();
        for (Map.Entry<LocalDate, List<Task>> entry : grouped.entrySet()) {
            days.add(new CalendarMonthResponse.DayTasks(entry.getKey(), hydrate(entry.getValue())));
        }
        return new CalendarMonthResponse(year, month, days);
    }

    @Transactional(readOnly = true)
    public TaskStatsResponse stats() {
        ZoneId zone = TimeZones.zone();
        OffsetDateTime now = TimeZones.now();
        LocalDate today = LocalDate.now(zone);
        OffsetDateTime dayStart = today.atStartOfDay(zone).toOffsetDateTime();
        OffsetDateTime nextDayStart = today.plusDays(1).atStartOfDay(zone).toOffsetDateTime();
        OffsetDateTime in7Days = today.plusDays(7).atStartOfDay(zone).toOffsetDateTime();

        List<Task> all = taskRepository.findAll();
        Map<TaskStatus, Long> statusCounts = new EnumMap<>(TaskStatus.class);
        Map<TaskType, Long> typeCounts = new EnumMap<>(TaskType.class);
        long open = 0;
        long overdue = 0;
        long dueToday = 0;
        long dueIn7Days = 0;
        long completed = 0;
        long withoutDeadline = 0;

        for (Task task : all) {
            statusCounts.merge(task.getStatus(), 1L, Long::sum);
            typeCounts.merge(task.getType(), 1L, Long::sum);
            OffsetDateTime deadline = task.getDeadline();
            if (deadline == null) {
                withoutDeadline++;
            }
            if (task.getStatus().isClosed()) {
                completed++;
                continue;
            }
            open++;
            if (deadline == null) {
                continue;
            }
            if (deadline.isBefore(now)) {
                overdue++;
            }
            if (!deadline.isBefore(dayStart) && deadline.isBefore(nextDayStart)) {
                dueToday++;
            }
            if (!deadline.isBefore(now) && deadline.isBefore(in7Days)) {
                dueIn7Days++;
            }
        }

        List<TaskStatsResponse.StatusCount> byStatus = new ArrayList<>();
        for (TaskStatus status : TaskStatus.values()) {
            byStatus.add(new TaskStatsResponse.StatusCount(status.name(), status.getLabel(),
                    statusCounts.getOrDefault(status, 0L)));
        }
        List<TaskStatsResponse.TypeCount> byType = new ArrayList<>();
        for (TaskType type : TaskType.values()) {
            byType.add(new TaskStatsResponse.TypeCount(type.name(), type.getLabel(),
                    typeCounts.getOrDefault(type, 0L)));
        }

        return new TaskStatsResponse(all.size(), open, overdue, dueToday, dueIn7Days, completed, withoutDeadline,
                byStatus, byType);
    }

    @Transactional(readOnly = true)
    public TaskResponse get(Long id) {
        Task task = require(id);
        List<TaskSource> sources = sourceRepository.findByTaskIdWithAttachments(id);
        return ApiMapper.task(task, sources.size(), flatten(sources));
    }

    // ------------------------------------------------------------------ 写入

    @Transactional
    public TaskResponse create(TaskRequest request) {
        Task task = new Task(request.title().trim());
        applyFull(task, request);
        if (request.status() != null && !request.status().isBlank()) {
            setStatus(task, Enums.taskStatus(request.status(), TaskStatus.TODO));
        }
        Task saved = taskRepository.save(task);
        return ApiMapper.task(saved, 0, List.of());
    }

    @Transactional
    public TaskResponse update(Long id, TaskRequest request) {
        Task task = require(id);
        task.setTitle(request.title().trim());
        applyFull(task, request);
        if (request.status() != null && !request.status().isBlank()) {
            setStatus(task, Enums.taskStatus(request.status(), task.getStatus()));
        }
        Task saved = taskRepository.save(task);
        List<TaskSource> sources = sourceRepository.findByTaskIdWithAttachments(id);
        return ApiMapper.task(saved, sources.size(), flatten(sources));
    }

    @Transactional
    public TaskResponse patch(Long id, TaskPatchRequest request) {
        Task task = require(id);
        if (request.title() != null) {
            if (request.title().isBlank()) {
                throw new InvalidRequestException("title", "任务标题不能为空");
            }
            task.setTitle(request.title().trim());
        }
        if (request.description() != null) {
            task.setDescription(blankToNull(request.description()));
        }
        if (Boolean.TRUE.equals(request.clearCourse())) {
            task.setCourse(null);
        } else if (request.courseId() != null) {
            task.setCourse(requireCourse(request.courseId()));
        }
        if (request.type() != null) {
            task.setType(Enums.taskType(request.type(), task.getType()));
        }
        if (request.status() != null) {
            setStatus(task, Enums.taskStatus(request.status(), task.getStatus()));
        }
        if (request.priority() != null) {
            task.setPriority(Enums.taskPriority(request.priority()));
        }
        if (Boolean.TRUE.equals(request.clearDeadline())) {
            task.setDeadline(null);
        } else if (request.deadline() != null) {
            task.setDeadline(request.deadline());
        }
        if (request.estimatedMinutes() != null) {
            task.setEstimatedMinutes(request.estimatedMinutes());
        }
        if (request.submitRequirement() != null) {
            task.setSubmitRequirement(blankToNull(request.submitRequirement()));
        }
        if (request.submitMethod() != null) {
            task.setSubmitMethod(blankToNull(request.submitMethod()));
        }
        Task saved = taskRepository.save(task);
        List<TaskSource> sources = sourceRepository.findByTaskIdWithAttachments(id);
        return ApiMapper.task(saved, sources.size(), flatten(sources));
    }

    @Transactional
    public TaskResponse changeStatus(Long id, TaskStatus status) {
        Task task = require(id);
        setStatus(task, status);
        Task saved = taskRepository.save(task);
        List<TaskSource> sources = sourceRepository.findByTaskIdWithAttachments(id);
        return ApiMapper.task(saved, sources.size(), flatten(sources));
    }

    /**
     * 删除任务，并清理它的原通知与附件（含磁盘文件）。
     *
     * <p>顺序很重要：{@code Task} 与 {@code TaskSource} 之间只有 {@code TaskSource.task} 这个
     * 单向 {@code @ManyToOne}，**没有**从 Task 到 sources 的级联映射。所以必须先显式删除来源
     * （附件由 {@code TaskSource.attachments} 的 {@code CascadeType.ALL + orphanRemoval} 级联删除）
     * 并 flush，最后才删除任务；否则已加载的 {@code TaskSource} 仍指向被删除的 Task，
     * 提交时 Hibernate 会抛 TransientObjectException。</p>
     *
     * <p>磁盘图片在**事务提交成功后**才删除：事务回滚时文件仍在，
     * 不会出现"数据库还有记录、文件已经没了"的坏状态。</p>
     */
    @Transactional
    public void delete(Long id) {
        Task task = require(id);
        List<TaskSource> sources = sourceRepository.findByTaskIdWithAttachments(id);
        List<String> paths = new ArrayList<>();
        for (TaskSource source : sources) {
            for (Attachment attachment : source.getAttachments()) {
                paths.add(attachment.getRelativePath());
            }
        }

        if (!sources.isEmpty()) {
            sourceRepository.deleteAll(sources);
            sourceRepository.flush();
        }
        taskRepository.delete(task);
        taskRepository.flush();

        registerAfterCommitFileDeletion(paths);
    }

    /** 事务提交后再删磁盘文件；无活跃事务时立即删除。 */
    private void registerAfterCommitFileDeletion(List<String> relativePaths) {
        if (relativePaths.isEmpty()) {
            return;
        }
        if (!org.springframework.transaction.support.TransactionSynchronizationManager.isSynchronizationActive()) {
            for (String path : relativePaths) {
                storageService.deleteByRelativePath(path);
            }
            return;
        }
        org.springframework.transaction.support.TransactionSynchronizationManager.registerSynchronization(
                new org.springframework.transaction.support.TransactionSynchronization() {
                    @Override
                    public void afterCommit() {
                        for (String path : relativePaths) {
                            storageService.deleteByRelativePath(path);
                        }
                    }
                });
    }

    @Transactional(readOnly = true)
    public Task require(Long id) {
        return taskRepository.findById(id)
                .orElseThrow(() -> new ResourceNotFoundException("任务", id));
    }

    // ------------------------------------------------------------------ 内部

    private void applyFull(Task task, TaskRequest request) {
        task.setDescription(blankToNull(request.description()));
        task.setCourse(request.courseId() == null ? null : requireCourse(request.courseId()));
        task.setType(Enums.taskType(request.type(), task.getType() == null ? TaskType.HOMEWORK : task.getType()));
        task.setPriority(Enums.taskPriority(request.priority()));
        task.setDeadline(request.deadline());
        task.setEstimatedMinutes(request.estimatedMinutes());
        task.setSubmitRequirement(blankToNull(request.submitRequirement()));
        task.setSubmitMethod(blankToNull(request.submitMethod()));
    }

    private void setStatus(Task task, TaskStatus status) {
        task.setStatus(status);
        if (status.isClosed()) {
            if (task.getCompletedAt() == null) {
                task.setCompletedAt(TimeZones.now());
            }
        } else {
            task.setCompletedAt(null);
        }
    }

    private Course requireCourse(Long courseId) {
        return courseRepository.findById(courseId)
                .orElseThrow(() -> new ResourceNotFoundException("课程", courseId));
    }

    private Specification<Task> buildSpec(TaskQuery query, OffsetDateTime now) {
        return (root, criteriaQuery, cb) -> {
            // fetch 只在数据查询里做：count 查询的 resultType 是 Long，不需要也不允许 fetch
            if (criteriaQuery != null && Long.class != criteriaQuery.getResultType()) {
                root.fetch("course", JoinType.LEFT);
            }
            List<Predicate> predicates = new ArrayList<>();
            if (query.courseId() != null) {
                predicates.add(cb.equal(root.get("course").get("id"), query.courseId()));
            }
            if (query.status() != null) {
                predicates.add(cb.equal(root.get("status"), query.status()));
            } else if (!query.includeDone()) {
                predicates.add(cb.not(root.get("status").in(TaskStatus.DONE, TaskStatus.ARCHIVED)));
            }
            if (query.type() != null) {
                predicates.add(cb.equal(root.get("type"), query.type()));
            }
            if (query.priority() != null) {
                predicates.add(cb.equal(root.get("priority"), Enums.taskPriority(query.priority())));
            }
            if (query.keyword() != null && !query.keyword().isBlank()) {
                String pattern = "%" + query.keyword().trim().toLowerCase() + "%";
                predicates.add(cb.or(
                        cb.like(cb.lower(root.get("title")), pattern),
                        cb.like(cb.lower(cb.coalesce(root.get("description"), "")), pattern),
                        cb.like(cb.lower(cb.coalesce(root.get("submitRequirement"), "")), pattern)));
            }
            if (query.dueFrom() != null) {
                predicates.add(cb.greaterThanOrEqualTo(root.<OffsetDateTime>get("deadline"), query.dueFrom()));
            }
            if (query.dueTo() != null) {
                predicates.add(cb.lessThanOrEqualTo(root.<OffsetDateTime>get("deadline"), query.dueTo()));
            }
            if (Boolean.TRUE.equals(query.overdueOnly())) {
                predicates.add(cb.lessThan(root.<OffsetDateTime>get("deadline"), now));
                predicates.add(cb.not(root.get("status").in(TaskStatus.DONE, TaskStatus.ARCHIVED)));
            }
            return cb.and(predicates.toArray(new Predicate[0]));
        };
    }

    /**
     * 内存比较器：负责"没有 DDL 的任务排在最后"这个空值偏好。
     *
     * <p>不用 Criteria 的 NULLS LAST（Hibernate 6.6 对 Criteria 查询直接抛
     * UnsupportedOperationException），因此在内存里实现，行为在 H2 与 MySQL 上一致。</p>
     */
    private java.util.Comparator<Task> taskComparator(String sort, String direction) {
        String key = sort == null || sort.isBlank() ? "deadline" : sort.trim().toLowerCase(java.util.Locale.ROOT);
        boolean desc = "desc".equalsIgnoreCase(direction);
        java.util.Comparator<Task> byId = java.util.Comparator.comparing(Task::getId,
                java.util.Comparator.nullsLast(java.util.Comparator.naturalOrder()));

        return switch (key) {
            case "priority" -> java.util.Comparator
                    .<Task, Integer>comparing(task -> task.getPriority().getLevel(),
                            desc ? java.util.Comparator.reverseOrder() : java.util.Comparator.naturalOrder())
                    .thenComparing(java.util.Comparator.comparing(Task::getDeadline,
                            java.util.Comparator.nullsLast(java.util.Comparator.naturalOrder())))
                    .thenComparing(byId);
            case "createdat", "created_at" -> java.util.Comparator
                    .<Task, OffsetDateTime>comparing(Task::getCreatedAt,
                            desc ? java.util.Comparator.reverseOrder() : java.util.Comparator.naturalOrder())
                    .thenComparing(byId);
            case "updatedat", "updated_at" -> java.util.Comparator
                    .<Task, OffsetDateTime>comparing(Task::getUpdatedAt,
                            desc ? java.util.Comparator.reverseOrder() : java.util.Comparator.naturalOrder())
                    .thenComparing(byId);
            case "title" -> java.util.Comparator
                    .<Task, String>comparing(Task::getTitle,
                            desc ? java.util.Comparator.reverseOrder() : java.util.Comparator.naturalOrder())
                    .thenComparing(byId);
            case "course" -> java.util.Comparator
                    .<Task, String>comparing(task -> task.getCourse() == null ? null : task.getCourse().getCode(),
                            java.util.Comparator.nullsLast(java.util.Comparator.naturalOrder()))
                    .thenComparing(java.util.Comparator.comparing(Task::getDeadline,
                            java.util.Comparator.nullsLast(java.util.Comparator.naturalOrder())))
                    .thenComparing(byId);
            // deadline（默认）：无 DDL 永远排最后，其余按方向
            default -> java.util.Comparator
                    .comparing(Task::getDeadline, desc
                            ? java.util.Comparator.nullsLast(java.util.Comparator.reverseOrder())
                            : java.util.Comparator.nullsLast(java.util.Comparator.naturalOrder()))
                    .thenComparing(Task::getPriority, java.util.Comparator.reverseOrder())
                    .thenComparing(byId);
        };
    }

    /** 批量补全来源数量与附件，避免逐条查询。 */
    private List<TaskResponse> hydrate(List<Task> tasks) {
        if (tasks.isEmpty()) {
            return List.of();
        }
        return hydrate(tasks, sourceRepository.findByTaskIdInWithAttachments(
                tasks.stream().map(Task::getId).toList()));
    }

    /** 已知来源列表时的补全（分页场景复用查询结果）。 */
    private List<TaskResponse> hydrate(List<Task> tasks, List<TaskSource> sources) {
        if (tasks.isEmpty()) {
            return List.of();
        }
        Map<Long, List<TaskSource>> sourcesByTask = sources.stream()
                .filter(source -> source.getTask() != null)
                .collect(Collectors.groupingBy(source -> source.getTask().getId(),
                        LinkedHashMap::new, Collectors.toList()));

        List<TaskResponse> result = new ArrayList<>(tasks.size());
        for (Task task : tasks) {
            List<TaskSource> taskSources = sourcesByTask.getOrDefault(task.getId(), List.of());
            result.add(ApiMapper.task(task, taskSources.size(), flatten(taskSources)));
        }
        return result;
    }

    private List<Attachment> flatten(List<TaskSource> sources) {
        List<Attachment> attachments = new ArrayList<>();
        for (TaskSource source : sources) {
            attachments.addAll(source.getAttachments());
        }
        return attachments;
    }

    private String blankToNull(String value) {
        if (value == null) {
            return null;
        }
        String trimmed = value.trim();
        return trimmed.isEmpty() ? null : trimmed;
    }

    /** 任务列表过滤条件。overdueOnly=true 时只返回"未完成且已逾期"的任务。 */
    public record TaskQuery(
            Long courseId,
            TaskStatus status,
            TaskType type,
            Integer priority,
            String keyword,
            OffsetDateTime dueFrom,
            OffsetDateTime dueTo,
            boolean includeDone,
            int page,
            int size,
            String sort,
            String direction,
            Boolean overdueOnly) {

        /** 从 HTTP 查询参数解析过滤条件，枚举/优先级非法时抛 400。 */
        public static TaskQuery of(Long courseId, String status, String type, Integer priority, String keyword,
                OffsetDateTime dueFrom, OffsetDateTime dueTo, Boolean includeDone, Integer page, Integer size,
                String sort, String direction, Boolean overdueOnly) {
            return new TaskQuery(
                    courseId,
                    Enums.taskStatus(status, null),
                    Enums.taskType(type, null),
                    priority,
                    keyword,
                    dueFrom,
                    dueTo,
                    Boolean.TRUE.equals(includeDone),
                    page == null ? 0 : page,
                    size == null ? 20 : size,
                    sort,
                    direction,
                    Boolean.TRUE.equals(overdueOnly));
        }
    }
}
