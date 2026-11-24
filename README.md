# ligatrix-deploy

Production deployment templates for a Node.js web application with PostgreSQL behind nginx, and a checker that keeps
them hardened.

![CI](https://github.com/Ligatrix/ligatrix-deploy/actions/workflows/ci.yml/badge.svg)

## Why

Most internal systems are deployed once by hand, then copied from project to project with the mistakes included: a
container running as root, a database password committed to the Compose file, nginx missing half its security
headers, backups that nobody has ever restored, and a release that drops every request in flight. None of it shows
until an audit, an incident or a client's security questionnaire.

This repository is the deployment we start every internal system from: one host, Docker Compose, nginx in front,
Postgres behind, each decision written down and enforced by a test, so a later change cannot quietly undo it.

## What you get

| Path | What it is |
| --- | --- |
| `app/` | Reference service with zero dependencies: `/healthz`, `/readyz` (probes Postgres), `/`, JSON logs, validated configuration, graceful shutdown |
| `docker/Dockerfile` | Multi-stage `node:22-alpine` image, non-root, read-only code, no package managers, `HEALTHCHECK` |
| `.dockerignore` | Allow-list: only `app/package.json` and `app/src/` enter the build context |
| `compose/compose.yaml` | nginx + app + `postgres:16`, health-gated startup, internal database network, an on-demand backup job |
| `compose/.env.example` | Every setting the stack reads; placeholders only |
| `nginx/` | TLS server, HTTP to HTTPS redirect, security headers, gzip, upstream keep-alive, body limits, rate limits on sign-in paths |
| `scripts/backup.sh`, `scripts/restore.sh` | `pg_dump` custom-format backups with verification, checksums, locking and retention; checked, single-transaction restore |
| `scripts/dev-certs.sh` | Self-signed certificate for running the stack locally |
| `scripts/check.mjs` | Static checks for all of the above, run by `npm test` and CI |
| `docs/` | [Deploy checklist](docs/deploy-checklist.md), [zero-downtime releases](docs/zero-downtime.md), [backups](docs/backups.md) |

## Request flow

```
            +---------------------------- one host -----------------------------+
            |                                                                   |
            |   network "frontend"                network "backend" (internal)  |
            |                                                                   |
 browser ---:80----> nginx :8080 ---> 301 to https://                           |
            |                                                                   |
 browser ---:443---> nginx :8443                                                |
            |          TLS 1.2/1.3, security headers,                           |
            |          rate limits, X-Request-ID                                |
            |            |                                                      |
            |            | HTTP/1.1, keep-alive                                 |
            |            v                                                      |
            |          app :3000  -------------------------->  db :5432         |
            |          /healthz  liveness (Docker)             postgres:16      |
            |          /readyz   readiness, probes db          volume "pgdata"  |
            |          /         the application                  ^             |
            |                                                     |             |
            |                          backup job (on demand) ----+--> backups/ |
            +-------------------------------------------------------------------+
```

nginx can reach the app but not the database; the database has no route outside the `backend` network and no port
on the host. Startup order is enforced by health: `db` healthy, then `app` healthy, then `nginx`.

## Quick start

Requires Docker with the Compose plugin. From the repository root:

```sh
cp compose/.env.example compose/.env && sed -i "s/CHANGE_ME/$(openssl rand -hex 32)/" compose/.env
./scripts/dev-certs.sh
docker compose -f compose/compose.yaml up -d --build
```

Open https://localhost (the browser warns about the self-signed certificate). For a real host, follow
[docs/deploy-checklist.md](docs/deploy-checklist.md).

Without Docker, the reference service runs on Node.js 20 or later with nothing to install: `npm start`.

## Usage

### The reference service

```sh
$ npm start
{"time":"2026-11-24T22:37:48.768Z","level":"info","msg":"listening","service":"reference-app","host":"0.0.0.0","port":3000,"readyCheck":"none","database":null}

$ curl -s localhost:3000/healthz
{"status":"ok","uptimeSeconds":0}

$ curl -s localhost:3000/readyz
{"status":"ready","checks":{"none":{"ok":true,"latencyMs":0,"skipped":true}}}
```

With a database configured and unreachable, readiness fails and says why; the password never reaches the log:

```sh
$ DATABASE_URL=postgres://app:secret@127.0.0.1:5432/app PORT=3001 node app/src/main.js
{"time":"2026-11-24T22:37:50.219Z","level":"info","msg":"listening","service":"reference-app","host":"0.0.0.0","port":3001,"readyCheck":"postgres","database":"postgres://app:***@127.0.0.1:5432/app"}

$ curl -s localhost:3001/readyz
{"status":"unavailable","checks":{"postgres":{"ok":false,"latencyMs":1,"error":"ECONNREFUSED"}}}
```

Bad configuration stops the process before it listens, with every problem at once and exit code 78:

```sh
$ PORT=abc LOG_LEVEL=loud READY_CHECK=tcp node app/src/main.js; echo "exit $?"
{"time":"2026-11-24T22:27:02.235Z","level":"error","msg":"invalid configuration","problems":["PORT must be a whole number, got \"abc\"","LOG_LEVEL must be one of debug, info, warn, error, got \"loud\"","READY_CHECK=tcp needs READY_CHECK_TARGET as host:port"]}
exit 78
```

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `3000` | Listening port |
| `HOST` | `0.0.0.0` | Listening address |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn` or `error` |
| `DATABASE_URL` | none | `postgres://...`; turns on the Postgres readiness probe |
| `READY_CHECK` | `postgres` with a `DATABASE_URL`, else `none` | `postgres`, `tcp` or `none` |
| `READY_CHECK_TARGET` | none | `host:port` for `READY_CHECK=tcp` |
| `READY_TIMEOUT_MS` | `1000` | Probe timeout |
| `DRAIN_DELAY_MS` | `0` | After `SIGTERM`, how long `/readyz` reports draining before new connections are refused |
| `SHUTDOWN_TIMEOUT_MS` | `10000` | After `SIGTERM`, how long in-flight requests get before connections are closed |

### The checker

```sh
$ npm run check

> @ligatrix/deploy@1.0.0 check
> node scripts/check.mjs

ok    docker/Dockerfile
ok    .dockerignore
ok    compose/compose.yaml
ok    compose/.env.example
ok    nginx/nginx.conf
ok    scripts/backup.sh
ok    scripts/dev-certs.sh
ok    scripts/restore.sh

8 of 8 files pass
```

Point it at your own files; the type comes from the file name. A location with its own `add_header` silently drops
every header set at server level, and the checker catches it:

```sh
$ node scripts/check.mjs test/fixtures/Dockerfile.unpinned test/fixtures/nginx-location-override.conf
FAIL  test/fixtures/Dockerfile.unpinned
      - base image "node:latest" uses the latest tag; pin a version tag or digest
      - single-stage build; use a separate build stage so build tools stay out of the image
      - final stage has no USER; the container would run as root
      - no HEALTHCHECK
      - CMD uses shell form; use exec form ["..."] so the process receives SIGTERM
FAIL  test/fixtures/nginx-location-override.conf
      - location /static/ does not set Strict-Transport-Security
      - location /static/ does not set Content-Security-Policy
      - location /static/ does not set X-Content-Type-Options
      - location /static/ does not set Referrer-Policy
      - location /static/ does not set Permissions-Policy

0 of 2 files pass
```

| File | Rules |
| --- | --- |
| Dockerfile | every base image pinned (tag or digest, never `latest`, `ARG` defaults resolved); multi-stage; final `USER` not root; `HEALTHCHECK` present and not `NONE`; no `ADD`; no secrets in `ENV`/`ARG`; exec-form `CMD` |
| `.dockerignore` | allow-list, or excludes `.git`, `.env` and `node_modules` |
| Compose | every long-running service has a healthcheck; images pinned; secret-named variables only as `${VAR}`; no password inside a URL; `depends_on` with `condition: service_healthy`; no `privileged`, host networking or Docker socket; named volumes declared; Postgres data on a named volume |
| `.env.example` | secret-named keys hold placeholders only |
| nginx | the five required headers on every TLS server, each with `always`; HSTS of at least 180 days; no `location` that drops them; plain HTTP only redirects; `server_tokens off`; TLS 1.2/1.3 only; gzip; body size limit; rate-limited sign-in paths; upstream keep-alive with HTTP/1.1 |
| shell | bash shebang; `set -euo pipefail` first; no `rm -r` on an unquoted variable; no backticks |

Compose files are read with a small YAML parser written for the subset Compose uses; anchors, merge keys and tags
are reported as unsupported rather than misread. nginx `include` directives are followed, so headers kept in a
snippet count.

### Backups

A run against a local Postgres 16 holding 500 rows, then a restore into a scratch database
(`PGHOST`, `PGUSER` and `PGPASSWORD` set in the environment):

```sh
$ PGDATABASE=app ./scripts/backup.sh --dir backups
2026-11-24T22:39:01Z backup: dumping app to backups/app_20261124T223901Z.dump
2026-11-24T22:39:01Z backup: verified 2766 bytes, checksum in app_20261124T223901Z.dump.sha256
2026-11-24T22:39:01Z backup: retention 14 days: removed 0, kept 1
backups/app_20261124T223901Z.dump

$ ./scripts/restore.sh --file backups/app_20261124T223901Z.dump --dbname app_restore_check --yes
2026-11-24T22:39:01Z restore: checksum ok
2026-11-24T22:39:01Z restore: archive ok: 3 entries
2026-11-24T22:39:01Z restore: restoring backups/app_20261124T223901Z.dump
2026-11-24T22:39:02Z restore: restore complete
```

In the Compose stack the same script runs as an on-demand job on the internal network:
`docker compose -f compose/compose.yaml --profile ops run --rm backup`.
Scheduling, off-host copies and the restore procedure are in [docs/backups.md](docs/backups.md).

## Hardening decisions

**Image**
- *Multi-stage build.* The build stage syntax-checks every file (`node --check`) so a broken commit fails the build,
  not the container start. The runtime stage receives only `package.json` and `src/`.
- *npm, npx and yarn removed from the runtime image.* A service does not install packages at run time; fewer
  binaries means less for an attacker to use and fewer CVEs to triage.
- *Code owned by root, process runs as `node` (uid 1000).* The process can read its code but not rewrite it.
- *`HEALTHCHECK` in Node, not curl.* The image needs no extra package for it, and Docker, Compose and the rollout
  procedure all read the same signal.
- *Exec-form `CMD`, `STOPSIGNAL SIGTERM`.* Node is the process that receives the signal; a shell in between would
  swallow it and turn every stop into a 10-second kill. Compose adds `init: true` to reap stray child processes.
- *Tags, not digests, in the templates.* Readable and still pinned to a major version; production should pin
  `@sha256:` digests and let a dependency bot raise them. The checker accepts both.

**Compose**
- *Secrets only through `${VAR:?message}`.* Compose refuses to start when one is missing instead of starting with an
  empty password. Environment variables are visible to `docker inspect`; for stricter needs switch Postgres to
  `POSTGRES_PASSWORD_FILE` with Compose `secrets:`. The checker already accepts `/run/secrets/` paths.
- *Two networks, the backend `internal`.* The database has no published port and no route out; nginx cannot reach
  it even if compromised.
- *Health-gated startup.* `depends_on: condition: service_healthy` means the app does not start against a database
  that is still initialising, and nginx does not start forwarding to an app that cannot serve.
- *`read_only`, `cap_drop: ALL`, `no-new-privileges`* on the app and nginx, with `/tmp` as the only writable path.
  Postgres keeps its default capabilities: its entrypoint needs them to set up the data directory.
- *nginx unprivileged.* `nginxinc/nginx-unprivileged` runs as uid 101 on 8080/8443; Docker maps 80/443, so no
  long-running process in the stack holds root (Postgres's entrypoint starts as root and drops to `postgres`).
- *Log rotation and memory limits.* `json-file` capped at 5 x 10 MB per service, so logs cannot fill the disk; the
  app is limited to 512 MB and one CPU.

**nginx**
- *Security headers with `always`*, so 4xx and 5xx responses carry them too. HSTS for two years without `preload`
  (removal from the preload list takes months; add it once every subdomain is on HTTPS). A strict CSP
  (`default-src 'self'`, `frame-ancestors 'none'`) to loosen per directive when the application needs it.
- *Headers in one snippet included at server level, and no `add_header` in any location.* nginx replaces, rather
  than merges, inherited headers when a location adds its own; the checker enforces this.
- *TLS 1.2 and 1.3, Mozilla intermediate ciphers.* Clients from before about 2014 cannot connect.
- *Rate limits.* 10 requests a minute per address on sign-in paths with a burst of 5, answering 429; 20 a second
  elsewhere to stop floods without touching normal use; 50 concurrent connections per address.
- *Upstream keep-alive* with `proxy_http_version 1.1` and an empty `Connection` header, held for 60 s against the
  app's 65 s, so nginx never reuses a socket the app has just closed (the classic intermittent 502).
- *Request ids assigned by nginx*, passed upstream as `X-Request-ID` and written to both access and app logs,
  replacing any value the client sent.
- *Probe endpoints return 404 from outside.* `/healthz` and `/readyz` are for Docker and the proxy.
- *Limits on body size (10 MB) and slow clients* (15 s for headers and body).

**Application**
- *Configuration validated as a whole at startup*, all problems reported together, exit code 78 (`EX_CONFIG`) so an
  orchestrator can tell bad configuration from a crash.
- *Liveness and readiness are separate.* `/healthz` never touches the database: a database outage should take the
  app out of rotation, not get it restarted in a loop.
- *The readiness probe speaks the Postgres protocol* (an `SSLRequest` packet) without logging in: it proves Postgres
  is answering, needs no credentials, and costs the server almost nothing.
- *Graceful shutdown* in three stages (report draining, stop accepting, close stragglers after a timeout); see
  [docs/zero-downtime.md](docs/zero-downtime.md).
- *Structured logs*, one JSON object per line; probe requests logged at `debug` so they do not bury real traffic;
  database passwords redacted.

## Design notes

- **Single host, Compose.** Most internal systems serve hundreds of users, not millions; one well-run host with
  backups and a tested restore beats an orchestrator nobody on the team can operate. Moving to several hosts changes
  the rollout and the load balancer, not the image or the application contract.
- **The checker is part of the test suite.** Templates drift when they are copied and edited. Rules enforced in CI,
  each with a fixture that breaks it, survive the next person's change; rules in a wiki do not.
- **No dependencies, in the service or the tooling.** Nothing to install, audit or update; the YAML and nginx parsers
  cover only what these files use and reject the rest loudly.
- **Logical backups first.** `pg_dump` is simple, portable and easy to inspect, at the cost of losing up to a day of
  writes on a nightly schedule. When that is too much, add WAL archiving; the dumps remain as an independent copy.
- **The reference service is a stand-in.** Replace it with your application and keep its contract: the two probe
  endpoints, `SIGTERM` handling, logs on stdout, configuration from the environment.

## Testing

```sh
npm test
```

76 tests on `node:test`: configuration validation, logging, the readiness probes against stand-in servers, every
endpoint, graceful shutdown in process and as a real child process receiving `SIGTERM`, the backup and restore
scripts against stand-in `pg_dump` and `pg_restore` binaries, both parsers, and every checker rule against
deliberately broken fixtures in `test/fixtures/`. The same suite checks that this repository's own templates pass.

`npm run lint` checks tracked files for trailing whitespace, tabs and missing final newlines. CI runs both on Node.js
20 and 22 and validates the Compose file with `docker compose config`.

## Licence

MIT. See [LICENSE](LICENSE).

---
Built and maintained by the [Ligatrix](https://ligatrix.com) team. We build systems like this for companies: [book a call](https://ligatrix.com/contact/sales).
