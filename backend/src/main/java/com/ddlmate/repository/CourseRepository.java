package com.ddlmate.repository;

import java.util.List;

import org.springframework.data.jpa.repository.JpaRepository;

import com.ddlmate.domain.Course;

public interface CourseRepository extends JpaRepository<Course, Long> {

    boolean existsByCodeIgnoreCase(String code);

    List<Course> findAllByOrderByCodeAsc();

    List<Course> findByNameContainingIgnoreCaseOrCodeContainingIgnoreCaseOrderByCodeAsc(String name, String code);
}
