#!/usr/bin/env bash
# Restore a backup made by backup.sh into a Postgres database.
#
# The archive is checked before anything is touched: its checksum, its format and
# its table of contents. The restore runs in one transaction, so it either applies
# completely or leaves the database as it was.
#
# Exit codes: 0 success, 1 failure, 2 usage error.
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: restore.sh --file PATH --yes [--dbname NAME] [--no-checksum]

  --file PATH     backup to restore (a .dump from backup.sh)
  --yes           confirm: existing objects in the target database are replaced
  --dbname NAME   target database (default PGDATABASE, or the one in DATABASE_URL)
  --no-checksum   restore even when the .sha256 file is missing
  --check-only    verify the archive and exit without restoring

Connection: PGHOST, PGPORT, PGUSER, PGPASSWORD, PGDATABASE, or DATABASE_URL.
USAGE
}

log() { printf '%s restore: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2; }
die() { log "error: $1"; exit "${2:-1}"; }

file=""
confirmed=false
require_checksum=true
check_only=false
target_db=""
pg_restore_bin="${PG_RESTORE:-pg_restore}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --file) [[ $# -ge 2 ]] || die "--file needs a value" 2; file="$2"; shift 2 ;;
    --dbname) [[ $# -ge 2 ]] || die "--dbname needs a value" 2; target_db="$2"; shift 2 ;;
    --yes) confirmed=true; shift ;;
    --no-checksum) require_checksum=false; shift ;;
    --check-only) check_only=true; shift ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; die "unknown argument: $1" 2 ;;
  esac
done

[[ -n "$file" ]] || { usage >&2; die "--file is required" 2; }
[[ -f "$file" ]] || die "no such file: $file"
command -v "$pg_restore_bin" >/dev/null || die "pg_restore not found ($pg_restore_bin)"

if [[ -f "$file.sha256" ]]; then
  (cd "$(dirname "$file")" && sha256sum --check --status "$(basename "$file").sha256") \
    || die "checksum mismatch: $file does not match $file.sha256"
  log "checksum ok"
elif [[ "$require_checksum" == true ]]; then
  die "missing $file.sha256 (pass --no-checksum to restore anyway)"
fi

[[ "$(head -c 5 "$file")" == "PGDMP" ]] || die "$file is not a pg_dump custom-format archive"
listing="$("$pg_restore_bin" --list "$file")" || die "pg_restore cannot read $file"
entries="$(grep -cv '^;' <<<"$listing" || true)"
log "archive ok: ${entries} entries"

if [[ "$check_only" == true ]]; then
  exit 0
fi

[[ "$confirmed" == true ]] || die "refusing to restore without --yes: objects in the target database are replaced" 2

dbname_args=()
if [[ -n "$target_db" ]]; then
  dbname_args=(--dbname "$target_db")
elif [[ -n "${DATABASE_URL:-}" ]]; then
  dbname_args=(--dbname "$DATABASE_URL")
elif [[ -n "${PGDATABASE:-}" ]]; then
  dbname_args=(--dbname "$PGDATABASE")
else
  die "set --dbname, PGDATABASE or DATABASE_URL" 2
fi

log "restoring $file"
"$pg_restore_bin" --clean --if-exists --no-owner --single-transaction --exit-on-error \
  "${dbname_args[@]}" "$file" || die "pg_restore failed; the database was left unchanged"
log "restore complete"
