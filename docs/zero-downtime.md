# Zero-downtime releases

A release replaces the running application containers without dropping a request. On one host with Compose this
takes four parts working together: a new container that proves it is ready before it gets traffic, a proxy that
knows about both containers, an old container that finishes what it started before it exits, and database changes
that both versions can live with.

## What each part does

**The application** (`app/src/server.js`) handles `SIGTERM` in three steps:

1. `/readyz` answers `503 {"status":"draining"}` at once, while the process keeps accepting connections for
   `DRAIN_DELAY_MS` (2 s in `compose.yaml`). Anything polling readiness stops routing to it.
2. It stops accepting new connections, closes idle keep-alive connections, and answers every response still being
   written with `Connection: close`, so nginx does not reuse a socket that is about to disappear.
3. It exits 0 when the last request completes, or closes what is left after `SHUTDOWN_TIMEOUT_MS` (20 s).

Docker waits `stop_grace_period` (30 s) after `SIGTERM` before it sends `SIGKILL`. The order
`DRAIN_DELAY_MS < SHUTDOWN_TIMEOUT_MS < stop_grace_period` is what keeps the application in control of its own
shutdown; `loadConfig` rejects a drain delay longer than the timeout.

**nginx** (`nginx/conf.d/app.conf`, `nginx/snippets/proxy.conf`):

- resolves `app` when it loads its configuration and balances across every address Docker returns;
- on a connection error or a `502`/`503` from one container, retries the request on the other
  (`proxy_next_upstream`), at most twice. It never retries a `POST` or another non-idempotent request, so a form is
  never submitted twice;
- holds upstream keep-alive connections for 60 s, below the application's 65 s, so it never sends a request down a
  socket the application has just closed.

**Docker** marks the new container `healthy` only after `src/healthcheck.js` succeeds.

## Rolling one host

Run from the repository root. `docker compose` here means `docker compose -f compose/compose.yaml`.

```sh
# 1. Build the new version under a new tag.
sed -i 's/^APP_IMAGE=.*/APP_IMAGE=reference-app:1.1.0/' compose/.env
docker compose -f compose/compose.yaml build app

# 2. Start one new container next to the old one. --no-recreate leaves the old one running.
OLD=$(docker compose -f compose/compose.yaml ps -q app)
docker compose -f compose/compose.yaml up -d --no-deps --no-recreate --scale app=2 app

# 3. Wait until the new container is healthy.
NEW=$(docker compose -f compose/compose.yaml ps -q app | grep -v "$OLD")
until [ "$(docker inspect -f '{{.State.Health.Status}}' "$NEW")" = healthy ]; do sleep 2; done

# 4. Let nginx see both containers.
docker compose -f compose/compose.yaml exec nginx nginx -s reload

# 5. Stop the old container. It drains and exits on its own.
docker stop "$OLD" && docker rm "$OLD"

# 6. Let nginx forget the old address.
docker compose -f compose/compose.yaml exec nginx nginx -s reload
```

`nginx -s reload` starts new workers with the new configuration and lets the old workers finish their requests, so
the reload itself drops nothing.

If the new container never becomes healthy at step 3, remove it (`docker stop "$NEW" && docker rm "$NEW"`), set
`APP_IMAGE` back, and nothing has changed for users.

Requirements this relies on, already true in `compose.yaml`: the `app` service publishes no host port and has no
`container_name`, so two copies can run at once.

## Blue/green, for larger changes

When a release changes the nginx configuration and the application together, or you want to test the new version on
its real host before switching:

1. Start the new version as a second Compose project, `-p reference-app-green`, on the same `frontend` network.
2. Test it directly on its container address.
3. Point the `upstream` in `nginx/conf.d/app.conf` at the green service and `nginx -s reload`.
4. Keep blue running until you are sure; switching back is the same reload.

This costs twice the memory for the duration and is worth it for releases that are hard to undo.

## Database migrations

The old and the new application version run against the same database for the length of the roll. Every migration
must therefore work with both, which means splitting incompatible changes across releases (expand, then contract):

| Change | Release N (expand) | Release N+1 (contract) |
| --- | --- | --- |
| Rename a column | Add the new column, write both, backfill | Read the new column only, drop the old |
| Add a NOT NULL column | Add it nullable with a default, backfill | Add the NOT NULL constraint |
| Drop a column | Stop reading and writing it | Drop it |
| Drop a table | Stop using it | Drop it |

Run the migration before step 2. On large tables use `CREATE INDEX CONCURRENTLY` and add constraints `NOT VALID`
followed by `VALIDATE CONSTRAINT`, so writes are not blocked while they build. Set `lock_timeout` (for example
`SET lock_timeout = '5s'`) for the migration's connection, so a migration waiting on a lock fails instead of queuing every
query behind it.

## What this does not cover

- **Several hosts.** Put a load balancer in front and roll one host at a time, taking each out of the balancer
  through `/readyz` first.
- **Long-lived connections** (WebSockets, server-sent events). They outlast any reasonable grace period; clients must
  reconnect, and the application should close them with a reconnect hint when it starts draining.
- **nginx itself.** Configuration changes reload without downtime; replacing the nginx container drops the
  connections it holds, so do it in a quiet period or run two nginx instances behind a host-level balancer.
