# syntax=docker/dockerfile:1.7
# Keycloak for AWS/production (build context: repository root): pre-built for PostgreSQL, health endpoints on the
# management port (9000), the TELUS realm imported on first start (existing realms are left untouched).
# Runtime settings (KC_DB_URL, KC_HOSTNAME, secrets, TELUS_WEB_URL …) come from the environment — see infra/aws/ecs.tf.
ARG KEYCLOAK_IMAGE=quay.io/keycloak/keycloak:26.6.4
FROM ${KEYCLOAK_IMAGE} AS builder
ENV KC_DB=postgres KC_HEALTH_ENABLED=true KC_METRICS_ENABLED=true
RUN /opt/keycloak/bin/kc.sh build

FROM ${KEYCLOAK_IMAGE}
COPY --from=builder /opt/keycloak/ /opt/keycloak/
COPY infra/keycloak/telus-realm.json /opt/keycloak/data/import/telus-realm.json
# Amazon RDS certificate authorities (KC_DB_URL …sslmode=verify-full&sslrootcert=/opt/keycloak/rds-ca.pem).
ADD --chmod=644 https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem /opt/keycloak/rds-ca.pem
ENTRYPOINT ["/opt/keycloak/bin/kc.sh"]
CMD ["start", "--optimized", "--import-realm"]
