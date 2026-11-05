package com.ddlmate.service;

import java.util.List;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;
import org.springframework.web.multipart.MultipartFile;

import com.ddlmate.common.ErrorCodes;
import com.ddlmate.common.ResourceInUseException;
import com.ddlmate.repository.AttachmentRepository;
import com.ddlmate.repository.CourseRepository;
import com.ddlmate.repository.TaskRepository;

/**
 * 每个账号的用量上限（开放注册后防止单个账号占满服务器）。统计都只算当前用户自己的数据。
 * 超出时返回 409 QUOTA_EXCEEDED。默认值对正常使用足够宽裕。
 */
@Service
public class QuotaService {

    private final TaskRepository tasks;
    private final CourseRepository courses;
    private final AttachmentRepository attachments;
    private final long maxTasks;
    private final long maxCourses;
    private final long maxStorageBytes;

    public QuotaService(TaskRepository tasks, CourseRepository courses, AttachmentRepository attachments,
            @Value("${ddlmate.quota.max-tasks:5000}") long maxTasks,
            @Value("${ddlmate.quota.max-courses:200}") long maxCourses,
            @Value("${ddlmate.quota.max-storage-mb:100}") long maxStorageMb) {
        this.tasks = tasks;
        this.courses = courses;
        this.attachments = attachments;
        this.maxTasks = maxTasks;
        this.maxCourses = maxCourses;
        this.maxStorageBytes = maxStorageMb * 1024 * 1024;
    }

    public void checkNewTasks(int adding) {
        if (tasks.count() + adding > maxTasks) {
            throw new ResourceInUseException("任务数量已达上限（每个账号最多 " + maxTasks + " 个），请先清理不用的任务",
                    ErrorCodes.QUOTA_EXCEEDED);
        }
    }

    public void checkNewCourses(int adding) {
        if (courses.count() + adding > maxCourses) {
            throw new ResourceInUseException("课程数量已达上限（每个账号最多 " + maxCourses + " 门）", ErrorCodes.QUOTA_EXCEEDED);
        }
    }

    public void checkNewFiles(List<MultipartFile> files) {
        long adding = files == null ? 0 : files.stream().mapToLong(MultipartFile::getSize).sum();
        if (adding > 0 && attachments.totalSizeBytes() + adding > maxStorageBytes) {
            throw new ResourceInUseException("图片存储空间已满（每个账号 " + (maxStorageBytes / 1024 / 1024)
                    + " MB），请先删除不用的截图", ErrorCodes.QUOTA_EXCEEDED);
        }
    }
}
