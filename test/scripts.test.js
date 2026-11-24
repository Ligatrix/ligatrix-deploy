// backup.sh and restore.sh run against stand-in pg_dump and pg_restore binaries
// (PG_DUMP / PG_RESTORE), so their checks, retention and refusals are tested on
// any machine. A real round trip against Postgres is described in docs/backups.md.

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BACKUP = fileURLToPath(new URL('../scripts/backup.sh', import.meta.url));
const RESTORE = fileURLToPath(new URL('../scripts/restore.sh', import.meta.url));

const FAKE_DUMP = `#!/usr/bin/env bash
set -euo pipefail
for arg in "$@"; do
  case "$arg" in --file=*) out="\${arg#--file=}" ;; esac
done
printf '%s' "\${FAKE_DUMP_CONTENT-PGDMP fake archive}" > "$out"
exit "\${FAKE_DUMP_EXIT:-0}"
`;

const FAKE_RESTORE = `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == "--list" ]]; then
  [[ "$(head -c 5 "$2")" == "PGDMP" ]] || exit 1
  printf ';\\n; Archive created by a stand-in\\n1; 2615 TABLE public orders app\\n2; 0 TABLE DATA public orders app\\n'
  exit 0
fi
printf '%s\\n' "$*" >> "$FAKE_RESTORE_LOG"
exit "\${FAKE_RESTORE_EXIT:-0}"
`;

const created = [];
after(() => created.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function workspace() {
  const dir = mkdtempSync(join(tmpdir(), 'deploy-scripts-'));
  created.push(dir);
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'pg_dump'), FAKE_DUMP);
  writeFileSync(join(bin, 'pg_restore'), FAKE_RESTORE);
  chmodSync(join(bin, 'pg_dump'), 0o755);
  chmodSync(join(bin, 'pg_restore'), 0o755);
  const env = {
    PATH: process.env.PATH,
    PG_DUMP: join(bin, 'pg_dump'),
    PG_RESTORE: join(bin, 'pg_restore'),
    FAKE_RESTORE_LOG: join(dir, 'restore.log'),
  };
  return { dir, backups: join(dir, 'backups'), env };
}

function run(script, args, env) {
  return spawnSync('bash', [script, ...args], { env, encoding: 'utf8' });
}

function backupOnce(ws, extraEnv = {}, args = []) {
  return run(BACKUP, ['--dir', ws.backups, ...args], { ...ws.env, PGDATABASE: 'app', ...extraEnv });
}

test('backup writes a verified dump with a checksum and owner-only permissions', () => {
  const ws = workspace();
  const result = backupOnce(ws);
  assert.equal(result.status, 0, result.stderr);
  const file = result.stdout.trim();
  assert.match(file, /backups\/app_\d{8}T\d{6}Z\.dump$/);
  assert.equal(readFileSync(file, 'utf8'), 'PGDMP fake archive');
  assert.match(readFileSync(`${file}.sha256`, 'utf8'), /^[0-9a-f]{64} {2}app_\d{8}T\d{6}Z\.dump\n$/);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.match(result.stderr, /retention 14 days: removed 0, kept 1/);
});

test('backup refuses to run without connection settings', () => {
  const ws = workspace();
  const result = run(BACKUP, ['--dir', ws.backups], ws.env);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /set PGDATABASE/);
});

test('backup rejects an empty dump and leaves no partial file', () => {
  const ws = workspace();
  const result = backupOnce(ws, { FAKE_DUMP_CONTENT: '' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /empty file/);
  assert.deepEqual(readdirSync(ws.backups).filter((f) => !f.startsWith('.backup.lock')), []);
});

test('backup rejects output that is not a custom-format archive', () => {
  const ws = workspace();
  const result = backupOnce(ws, { FAKE_DUMP_CONTENT: '-- plain SQL' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /not a pg_dump custom-format archive/);
});

test('backup stops when pg_dump fails', () => {
  const ws = workspace();
  const result = backupOnce(ws, { FAKE_DUMP_EXIT: '1' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /pg_dump failed/);
});

test('retention removes expired backups but always keeps the newest ones', () => {
  const ws = workspace();
  mkdirSync(ws.backups);
  const day = 24 * 60 * 60;
  const now = Date.now() / 1000;
  const ages = { app_20200101T000000Z: 1, app_20200102T000000Z: 20, app_20200103T000000Z: 21, app_20200104T000000Z: 22, other_20200101T000000Z: 40 };
  for (const [name, days] of Object.entries(ages)) {
    const file = join(ws.backups, `${name}.dump`);
    writeFileSync(file, 'PGDMP old');
    writeFileSync(`${file}.sha256`, 'x');
    utimesSync(file, now - days * day, now - days * day);
  }
  const result = backupOnce(ws, {}, ['--retention-days', '14', '--keep-min', '3']);
  assert.equal(result.status, 0, result.stderr);
  const left = readdirSync(ws.backups).filter((f) => f.endsWith('.dump')).sort();
  // Kept: the new one, the 1-day-old one, and the newest expired one (keep-min 3).
  // Another label's files are never touched.
  assert.equal(left.length, 4);
  assert.ok(left.includes('app_20200101T000000Z.dump'));
  assert.ok(left.includes('app_20200102T000000Z.dump'));
  assert.ok(left.includes('other_20200101T000000Z.dump'));
  assert.ok(!existsSync(join(ws.backups, 'app_20200104T000000Z.dump.sha256')));
});

test('backup takes its label from DATABASE_URL and validates its options', () => {
  const ws = workspace();
  const ok = run(BACKUP, ['--dir', ws.backups], { ...ws.env, DATABASE_URL: 'postgres://u:p@db:5432/orders?sslmode=require' });
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /orders_\d{8}T\d{6}Z\.dump/);
  assert.equal(backupOnce(ws, {}, ['--retention-days', '0']).status, 2);
  assert.equal(backupOnce(ws, {}, ['--label', '../escape']).status, 2);
  assert.equal(backupOnce(ws, {}, ['--bogus']).status, 2);
});

test('restore refuses without --yes and does not touch the database', () => {
  const ws = workspace();
  const file = backupOnce(ws).stdout.trim();
  const result = run(RESTORE, ['--file', file], { ...ws.env, PGDATABASE: 'app' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /refusing to restore without --yes/);
  assert.equal(existsSync(ws.env.FAKE_RESTORE_LOG), false);
});

test('restore applies the archive in one transaction with --yes', () => {
  const ws = workspace();
  const file = backupOnce(ws).stdout.trim();
  const result = run(RESTORE, ['--file', file, '--yes'], { ...ws.env, PGDATABASE: 'app' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /archive ok: 2 entries/);
  const args = readFileSync(ws.env.FAKE_RESTORE_LOG, 'utf8');
  assert.match(args, /--clean --if-exists --no-owner --single-transaction --exit-on-error --dbname app/);
});

test('restore rejects a file whose checksum does not match', () => {
  const ws = workspace();
  const file = backupOnce(ws).stdout.trim();
  writeFileSync(file, 'PGDMP tampered');
  const result = run(RESTORE, ['--file', file, '--yes'], { ...ws.env, PGDATABASE: 'app' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /checksum mismatch/);
});

test('restore needs the checksum file unless told otherwise', () => {
  const ws = workspace();
  mkdirSync(ws.backups);
  const file = join(ws.backups, 'copied.dump');
  writeFileSync(file, 'PGDMP copied');
  const strict = run(RESTORE, ['--file', file, '--check-only'], ws.env);
  assert.equal(strict.status, 1);
  assert.match(strict.stderr, /missing .*\.sha256/);
  const relaxed = run(RESTORE, ['--file', file, '--check-only', '--no-checksum'], ws.env);
  assert.equal(relaxed.status, 0, relaxed.stderr);
});

test('restore reports a failed pg_restore', () => {
  const ws = workspace();
  const file = backupOnce(ws).stdout.trim();
  const result = run(RESTORE, ['--file', file, '--yes'], { ...ws.env, PGDATABASE: 'app', FAKE_RESTORE_EXIT: '1' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /pg_restore failed; the database was left unchanged/);
});
