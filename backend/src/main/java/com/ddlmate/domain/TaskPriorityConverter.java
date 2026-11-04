package com.ddlmate.domain;

import jakarta.persistence.AttributeConverter;
import jakarta.persistence.Converter;

/** 数据库存 1-5 数字，Java 用枚举，前后端都更好读。 */
@Converter(autoApply = true)
public class TaskPriorityConverter implements AttributeConverter<TaskPriority, Integer> {

    @Override
    public Integer convertToDatabaseColumn(TaskPriority attribute) {
        return attribute == null ? null : attribute.getLevel();
    }

    @Override
    public TaskPriority convertToEntityAttribute(Integer dbData) {
        return dbData == null ? null : TaskPriority.fromLevel(dbData);
    }
}
