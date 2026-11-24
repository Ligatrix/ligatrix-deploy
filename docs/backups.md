# Backups

`scripts/backup.sh` takes a logical backup of one Postgres database with `pg_dump`; `scripts/restore.sh` puts it
back. Both are plain bash and run on any host with the Postgres client tools, or inside the `postgres:16` image
through the `backup` service in `compose.yaml`.

## What a backup run does

1. Takes a lock on the backup directory, so two runs (a slow nightly and a manual one) never compete.
2. Dumps in custom format (`pg_dump --format=custom --compress=6`) to a hidden `.partial` file.
3. Refuses the result if it is empty, does not start with the `PGDMP` signature, or `pg_restore --list` cannot read
   its table of contents. A failed or interrupted run deletes the partial file, so anything named `*.dump` is a
   complete, readable archive.
4. Renames it to `<database>_<UTC timestamp>.dump` and writes `<file>.sha256` beside it.
5. Deletes backups older than `RETENTION_DAYS` (14), but always keeps the newest `KEEP_MIN` (3), so a job that has
   been failing for three weeks does not also delete the last good backup.
6. Prints the path of the new file on stdout; logs go to stderr.

Files are created with `umask 077`: a backup holds every row, including the ones you protect most.

Custom format is chosen over plain SQL because it is compressed, lets `pg_restore` restore a single table or list
the contents without restoring, and can be restored in parallel (`pg_restore --jobs`).

## Running it

With the Compose stack, as an on-demand job on the internal network:

```sh
docker compose -f compose/compose.yaml --profile ops run --rm backup
```

Backups land in `backups/` at the repository root (ignored by git).

From any host with the client tools:

```sh
PGHOST=db.internal PGUSER=app PGPASSWORD=... PGDATABASE=app \
  ./scripts/backup.sh --dir /var/backups/app --retention-days 30
```

`DATABASE_URL=postgres://app:...@db.internal:5432/app` works in place of the `PG*` variables. Prefer a
`~/.pgpass` file (mode 0600) over `PGPASSWORD` on shared hosts, where the environment of a process can be read by
other users.

Options: `--dir`, `--retention-days`, `--keep-min`, `--label`; `./scripts/backup.sh --help` lists them.

Exit codes: 0 success, 1 failure, 2 usage error, 3 another backup is already running.

## Scheduling

A systemd timer, so a missed run (host down at 02:00) runs at the next boot and failures reach the journal:

```ini
# /etc/systemd/system/app-backup.service
[Unit]
Description=Postgres backup for the application

[Service]
Type=oneshot
WorkingDirectory=/srv/app
ExecStart=/usr/bin/docker compose -f compose/compose.yaml --profile ops run --rm backup
```

```ini
# /etc/systemd/system/app-backup.timer
[Timer]
OnCalendar=*-*-* 02:00:00
Persistent=true
RandomizedDelaySec=15m

[Install]
WantedBy=timers.target
```

`systemctl enable --now app-backup.timer`. Alert on a failed unit (`OnFailure=` to a notification unit, or your
monitoring's systemd check), and separately alert when the newest file in the backup directory is older than 26
hours: that catches a timer that stopped firing.

## Off the host

A backup on the same disk as the database protects against mistakes, not against losing the host. Copy each new
file and its checksum somewhere else after the run, for example to object storage with versioning and an object
lock or retention policy, so that whoever can delete the server cannot also delete its backups. Encrypt before the
copy leaves the host if the storage is not under your control (`age -r <recipient> file.dump > file.dump.age`).

## Restore

Always restore into a scratch database first, check it, then decide.

```sh
createdb -h db.internal -U app app_restore_check
PGHOST=db.internal PGUSER=app PGPASSWORD=... \
  ./scripts/restore.sh --file backups/app_20261124T020000Z.dump --dbname app_restore_check --yes
```

`restore.sh`:

- verifies the checksum (refuses when `.sha256` is missing unless `--no-checksum` is given), the `PGDMP` signature
  and the table of contents, before it connects to anything; `--check-only` stops there;
- refuses to run without `--yes`, because objects in the target database are dropped and recreated;
- restores with `--clean --if-exists --no-owner --single-transaction --exit-on-error`: one transaction, so an error
  half-way leaves the target exactly as it was.

Into the live database, through the stack:

```sh
docker compose -f compose/compose.yaml stop app
docker compose -f compose/compose.yaml --profile ops run --rm --entrypoint /scripts/restore.sh backup \
  --file /backups/app_20261124T020000Z.dump --yes
docker compose -f compose/compose.yaml start app
```

## Rehearse it

A backup that has never been restored is a hope. Once a month, restore the newest backup into a scratch database,
run a query that proves recent data is there (the newest row in a busy table), and write down how long it took. That
time is your real recovery time.

## Limits of logical backups

`pg_dump` gives a consistent snapshot as of the moment it started: with a nightly schedule you can lose up to a day
of writes. When that is too much, add continuous WAL archiving with point-in-time recovery (pgBackRest or WAL-G) or
use a managed Postgres that provides it, and keep these dumps as a second, independent copy that is easy to inspect.
