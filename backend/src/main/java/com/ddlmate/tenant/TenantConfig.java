package com.ddlmate.tenant;

import org.hibernate.cfg.AvailableSettings;
import org.springframework.boot.autoconfigure.orm.jpa.HibernatePropertiesCustomizer;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/** 把 {@link OwnerResolver} 交给 Hibernate，启用按用户的数据隔离。 */
@Configuration
public class TenantConfig {

    @Bean
    HibernatePropertiesCustomizer ownerResolverCustomizer(OwnerResolver resolver) {
        return properties -> properties.put(AvailableSettings.MULTI_TENANT_IDENTIFIER_RESOLVER, resolver);
    }
}
