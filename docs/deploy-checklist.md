# Deploy checklist

Work through this list for the first deploy to a new host and for every change to the stack itself. A routine
application release only needs [Release](#release) and [Verify](#verify).

## Host

- [ ] A supported Linux distribution with automatic security updates on (`unattended-upgrades` or equivalent).
- [ ] Docker Engine and the Compose plugin from Docker's own repository; `docker compose version` reports v2 or later.
- [ ] SSH by key only, password login and root login disabled.
- [ ] Firewall allows 22 (from known addresses only), 80 and 443. Nothing else is published: Postgres has no port on the
      host, and `docker compose ps` should show ports only on `nginx`.
- [ ] Clock synchronised (`timedatectl` shows `System clock synchronized: yes`); TLS and log timestamps depend on it.
- [ ] Disk alerts at 80 %: Docker logs are capped by the `json-file` options in `compose.yaml`, but images, volumes
      and backups grow.

## Configuration and secrets

- [ ] `cp compose/.env.example compose/.env`, then every `CHANGE_ME` replaced. Create the database password with
      `openssl rand -hex 32`.
- [ ] `chmod 600 compose/.env`, owned by the deploy user.
- [ ] `compose/.env` is not in git (`git status --ignored` lists it under ignored files).
- [ ] `docker compose -f compose/compose.yaml config --quiet` exits 0: Compose refuses to start if a required
      variable is missing.
- [ ] `npm test` passes on the commit being deployed; it includes `scripts/check.mjs`.

## TLS

- [ ] DNS for the hostname points at the host.
- [ ] A real certificate in `compose/certs/fullchain.pem` and `compose/certs/privkey.pem`. With Let's Encrypt and the
      webroot method, the stack already serves `/.well-known/acme-challenge/` from `compose/acme/`:

      certbot certonly --webroot -w compose/acme -d app.example.com

  then copy or link the two files into `compose/certs/`.
- [ ] Key readable by uid 101 (nginx inside its container) and nobody else:
      `chown 101:101 compose/certs/privkey.pem && chmod 400 compose/certs/privkey.pem`.
- [ ] Renewal scheduled, followed by `docker compose -f compose/compose.yaml exec nginx nginx -s reload`.
- [ ] Set `server_name` in `nginx/conf.d/app.conf` to the real hostname once more than one site shares the host.
- [ ] Before adding `preload` to HSTS, every subdomain serves HTTPS.

## Backups

- [ ] The backup job is scheduled and its first run succeeded ([backups.md](backups.md)).
- [ ] Backups are copied off the host.
- [ ] A restore has been rehearsed on a scratch database, and the time it took is written down.

## Release

1. `git pull` the tagged release; `npm test`.
2. `docker compose -f compose/compose.yaml build app`.
3. Run database migrations that are backward compatible with the running version (see
   [zero-downtime.md](zero-downtime.md#database-migrations)).
4. Roll the app as described in [zero-downtime.md](zero-downtime.md), or for a maintenance window:
   `docker compose -f compose/compose.yaml up -d`.

## Verify

```sh
docker compose -f compose/compose.yaml ps                  # every service "healthy"
curl -sI http://app.example.com/ | head -n 3               # 301 to https://
curl -sI https://app.example.com/                          # 200 with the headers below
docker compose -f compose/compose.yaml logs --since 5m app | grep '"level":"error"'   # nothing
```

The HTTPS response must carry `strict-transport-security`, `content-security-policy`, `x-content-type-options`,
`referrer-policy` and `permissions-policy`, and no `server: nginx/<version>`. An external scan (for example
Mozilla Observatory or SSL Labs) should grade A or better.

## Rollback

- Application: set `APP_IMAGE` in `compose/.env` back to the previous tag and roll again. Images are tagged per
  release so the previous one is still on the host.
- Configuration: `git revert` the change, `docker compose -f compose/compose.yaml up -d nginx` (nginx configuration
  only) or the full stack.
- Data: restore the last backup taken before the release ([backups.md](backups.md#restore)). Only when a migration
  destroyed data; prefer a forward fix.
