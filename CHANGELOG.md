# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.0] - 2026-11-24

### Added

- Reference service in `app/` with no dependencies: `/healthz`, `/readyz` with a Postgres protocol probe (or TCP, or
  none), an HTML page, JSON logs with request ids, configuration validated as a whole with exit code 78, and graceful
  shutdown with a drain delay and a forced-close timeout.
- `docker/Dockerfile`: multi-stage `node:22-alpine` build, non-root runtime, code owned by root, npm and yarn
  removed, Node-based `HEALTHCHECK`; allow-list `.dockerignore`.
- `compose/compose.yaml`: nginx, app and `postgres:16` with healthchecks, health-gated startup, an internal database
  network, read-only containers with all capabilities dropped, log rotation, resource limits and an on-demand backup
  job; `compose/.env.example`.
- `nginx/`: unprivileged nginx with HTTP to HTTPS redirect, TLS 1.2/1.3, HSTS, CSP, X-Content-Type-Options,
  Referrer-Policy and Permissions-Policy on every response, gzip, upstream keep-alive, body and timeout limits, rate
  limits on sign-in paths, JSON access logs, and the ACME webroot path.
- `scripts/backup.sh`: custom-format `pg_dump` with locking, archive verification, SHA-256 checksums and retention
  that always keeps the newest backups. `scripts/restore.sh`: checksum and archive checks, explicit confirmation,
  single-transaction restore. `scripts/dev-certs.sh` for local certificates.
- `scripts/check.mjs`: static checks for the Dockerfile, `.dockerignore`, Compose file, env example, nginx
  configuration (includes followed) and shell scripts, usable on a whole checkout or on individual files.
- Documentation: deploy checklist, zero-downtime releases, backups and restore.
- 76 tests on `node:test`, CI on Node.js 20 and 22.

[Unreleased]: https://github.com/Ligatrix/ligatrix-deploy/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/Ligatrix/ligatrix-deploy/releases/tag/v1.0.0
