#!/usr/bin/env bash
# Back up one Postgres database in pg_dump's custom format, verify the result,
# record a SHA-256 checksum and prune old backups.
#
# Connection settings come from the standard libpq variables (PGHOST, PGPORT,
# PGUSER, PGPASSWORD, PGDATABASE) or from DATABASE_URL.
#
# Exit codes: 0 success, 1 failure, 2 usage error, 3 another backup is running.
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: backup.sh [--dir DIR] [--retention-days N] [--keep-min N] [--label NAME]

  --dir DIR            where backups are written      (env BACKUP_DIR, default ./backups)
  --retention-days N   delete backups older than N    (env RETENTION_DAYS, default 14)
  --keep-min N         always keep the N newest       (env KEEP_MIN, default 3)
  --label NAME         file name prefix               (env BACKUP_LABEL, default the database name)

Connection: PGHOST, PGPORT, PGUSER, PGPASSWORD, PGDATABASE, or DATABASE_URL.
Prints the path of the new backup on stdout.
USAGE
}

log() { printf '%s backup: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2; }
die() { log "error: $1"; exit "${2:-1}"; }

backup_dir="${BACKUP_DIR:-./backups}"
retention_days="${RETENTION_DAYS:-14}"
keep_min="${KEEP_MIN:-3}"
label="${BACKUP_LABEL:-}"
pg_dump_bin="${PG_DUMP:-pg_dump}"
pg_restore_bin="${PG_RESTORE:-pg_restore}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dir) [[ $# -ge 2 ]] || die "--dir needs a value" 2; backup_dir="$2"; shift 2 ;;
    --retention-days) [[ $# -ge 2 ]] || die "--retention-days needs a value" 2; retention_days="$2"; shift 2 ;;
    --keep-min) [[ $# -ge 2 ]] || die "--keep-min needs a value" 2; keep_min="$2"; shift 2 ;;
    --label) [[ $# -ge 2 ]] || die "--label needs a value" 2; label="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; die "unknown argument: $1" 2 ;;
  esac
done

[[ "$retention_days" =~ ^[0-9]+$ && "$retention_days" -ge 1 ]] \
  || die "retention days must be a whole number of at least 1, got '$retention_days'" 2
[[ "$keep_min" =~ ^[0-9]+$ && "$keep_min" -ge 1 ]] \
  || die "keep-min must be a whole number of at least 1, got '$keep_min'" 2

dbname_args=()
if [[ -n "${DATABASE_URL:-}" ]]; then
  dbname_args=(--dbname "$DATABASE_URL")
  if [[ -z "$label" ]]; then
    label="${DATABASE_URL##*/}"
    label="${label%%\?*}"
  fi
elif [[ -n "${PGDATABASE:-}" ]]; then
  label="${label:-$PGDATABASE}"
else
  die "set PGDATABASE (with PGHOST, PGUSER, PGPASSWORD) or DATABASE_URL" 2
fi

[[ "$label" =~ ^[A-Za-z0-9._-]+$ ]] || die "label must use letters, digits, '.', '_' or '-', got '$label'" 2
command -v "$pg_dump_bin" >/dev/null || die "pg_dump not found ($pg_dump_bin)"
command -v "$pg_restore_bin" >/dev/null || die "pg_restore not found ($pg_restore_bin)"

# Backups hold every row of the database: readable by the owner only.
umask 077
mkdir -p "$backup_dir"

# One backup at a time per directory; a second run exits instead of competing.
if command -v flock >/dev/null; then
  exec 9>"$backup_dir/.backup.lock"
  flock -n 9 || die "another backup is running in $backup_dir" 3
fi

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
name="${label}_${stamp}.dump"
final="$backup_dir/$name"
partial="$backup_dir/.${name}.partial"
[[ ! -e "$final" ]] || die "$final already exists"

# A failed or interrupted dump never leaves a file that looks like a backup.
trap 'rm -f "$partial"' EXIT

log "dumping ${label} to ${final}"
"$pg_dump_bin" --format=custom --compress=6 --file="$partial" "${dbname_args[@]}" \
  || die "pg_dump failed"

[[ -s "$partial" ]] || die "pg_dump produced an empty file"
[[ "$(head -c 5 "$partial")" == "PGDMP" ]] || die "output is not a pg_dump custom-format archive"
"$pg_restore_bin" --list "$partial" >/dev/null || die "pg_restore cannot read the archive"

mv "$partial" "$final"
(cd "$backup_dir" && sha256sum "$name" > "$name.sha256")
log "verified $(wc -c < "$final" | tr -d ' ') bytes, checksum in ${name}.sha256"

# Retention: delete backups older than the window, but never the newest keep_min.
cutoff_minutes=$(( retention_days * 24 * 60 ))
mapfile -t backups < <(find "$backup_dir" -maxdepth 1 -type f -name "${label}_*.dump" -printf '%T@ %p\n' \
  | sort -rn | cut -d' ' -f2-)
pruned=0
for (( i = keep_min; i < ${#backups[@]}; i++ )); do
  old="${backups[$i]}"
  if [[ -n "$(find "$old" -mmin +"$cutoff_minutes")" ]]; then
    rm -f -- "$old" "$old.sha256"
    pruned=$(( pruned + 1 ))
  fi
done
log "retention ${retention_days} days: removed ${pruned}, kept $(( ${#backups[@]} - pruned ))"

printf '%s\n' "$final"
