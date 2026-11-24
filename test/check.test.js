import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  checkCompose,
  checkDockerfile,
  checkDockerignore,
  checkEnvExample,
  checkNginx,
  checkRepository,
  checkShellScript,
  imagePinProblem,
} from '../scripts/check.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const has = (problems, pattern) => problems.some((p) => pattern.test(p));

function assertFlags(problems, patterns) {
  for (const pattern of patterns) {
    assert.ok(has(problems, pattern), `expected a problem matching ${pattern}, got:\n  ${problems.join('\n  ')}`);
  }
}

test('every template in this repository passes', () => {
  const failures = checkRepository(ROOT).filter((r) => r.problems.length > 0);
  assert.deepEqual(failures, []);
});

test('the command line exits 0 here and prints one line per file', () => {
  const run = spawnSync(process.execPath, ['scripts/check.mjs'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stdout);
  assert.match(run.stdout, /ok {4}docker\/Dockerfile/);
  assert.match(run.stdout, /ok {4}scripts\/backup\.sh/);
});

test('image pinning: tags, digests, registries with ports', () => {
  assert.equal(imagePinProblem('node:22-alpine'), null);
  assert.equal(imagePinProblem(`node@sha256:${'a'.repeat(64)}`), null);
  assert.equal(imagePinProblem('registry.local:5000/team/app:1.4.2'), null);
  assert.match(imagePinProblem('registry.local:5000/team/app'), /no tag/);
  assert.match(imagePinProblem('nginx:latest'), /latest/);
  assert.match(imagePinProblem('nginx'), /no tag/);
});

test('Dockerfile: latest tag, single stage, no USER, no HEALTHCHECK, shell-form CMD', () => {
  const problems = checkDockerfile(fixture('Dockerfile.unpinned'));
  assertFlags(problems, [/uses the latest tag/, /single-stage/, /no USER/, /no HEALTHCHECK/, /shell form/]);
});

test('Dockerfile: root user, disabled healthcheck, ADD, baked secret, untagged base', () => {
  const problems = checkDockerfile(fixture('Dockerfile.root'));
  assertFlags(problems, [/runs as root/, /HEALTHCHECK is disabled/, /use COPY/, /DB_PASSWORD bakes a secret/, /"node" has no tag/]);
  assert.ok(!has(problems, /single-stage/));
});

test('Dockerfile: ARG defaults are resolved before the tag check', () => {
  const ok = 'ARG BASE=node:22-alpine\nFROM ${BASE} AS a\nFROM ${BASE}\nUSER node\nHEALTHCHECK CMD ["true"]\nCMD ["node"]\n';
  assert.deepEqual(checkDockerfile(ok), []);
  assert.ok(has(checkDockerfile(ok.replace('node:22-alpine', 'node:latest')), /latest/));
});

test('.dockerignore: allow-list passes, a partial deny-list is flagged', () => {
  assert.deepEqual(checkDockerignore('*\n!app/src/**\n'), []);
  assert.deepEqual(checkDockerignore('.git\n.env*\nnode_modules/\n'), []);
  assertFlags(checkDockerignore('node_modules\n'), [/exclude \.git/, /exclude \.env/]);
});

test('compose: healthchecks, tags, secrets, depends_on, privileges and volumes', () => {
  const problems = checkCompose(fixture('compose-bad.yaml'));
  assertFlags(problems, [
    /service "db" has no healthcheck/,
    /service "app" has no healthcheck/,
    /service "db" image "postgres:latest" uses the latest tag/,
    /service "app" image "example\/app" has no tag/,
    /POSTGRES_PASSWORD in plain text/,
    /DATABASE_URL contains a password in plain text/,
    /depends_on is a plain list/,
    /runs privileged/,
    /mounts the Docker socket/,
    /volume "cache" that is not declared/,
    /keeps Postgres data inside the container/,
  ]);
});

test('compose: interpolated secrets and on-demand jobs are accepted', () => {
  const text = [
    'services:',
    '  job:',
    '    image: postgres:16',
    '    profiles: [ops]',
    '    environment:',
    '      PGPASSWORD: ${POSTGRES_PASSWORD:?required}',
    '      DATABASE_URL: postgres://app:${POSTGRES_PASSWORD}@db/app',
    '',
  ].join('\n');
  assert.deepEqual(checkCompose(text), []);
});

test('compose: a disabled healthcheck counts as missing', () => {
  const text = 'services:\n  app:\n    image: app:1.0.0\n    healthcheck:\n      disable: true\n';
  assert.ok(has(checkCompose(text), /no healthcheck/));
});

test('compose: unsupported YAML is reported, not misread', () => {
  assertFlags(checkCompose(fixture('compose-broken.yaml')), [/not parseable: line 3: anchors/]);
  assertFlags(checkCompose('version: "3"\n'), [/no services defined/]);
});

test('.env example: real-looking secrets are flagged, placeholders pass', () => {
  const problems = checkEnvExample(fixture('env-bad.example'));
  assert.deepEqual(problems, ['POSTGRES_PASSWORD has a value; an example file holds placeholders only (CHANGE_ME)']);
});

test('nginx: missing headers, weak TLS, no redirect, no gzip, no limits, no keepalive', () => {
  const problems = checkNginx(fixture('nginx-bad.conf'));
  assertFlags(problems, [
    /does not set Content-Security-Policy/,
    /does not set Referrer-Policy/,
    /does not set Permissions-Policy/,
    /Strict-Transport-Security without "always"/,
    /HSTS max-age 3600 is below/,
    /does not redirect to https/,
    /proxies traffic without TLS/,
    /server_tokens is not off/,
    /ssl_protocols allows TLSv1$/,
    /gzip is not on/,
    /client_max_body_size is not set/,
    /no limit_req_zone/,
    /no auth or login location is rate limited/,
    /upstream app_backend has no keepalive/,
    /proxy_http_version 1\.1 is not set/,
  ]);
  assert.ok(!has(problems, /does not set X-Content-Type-Options/));
});

test('nginx: add_header in a location that drops the security headers is caught', () => {
  const problems = checkNginx(fixture('nginx-location-override.conf'));
  assert.deepEqual(problems, [
    'location /static/ does not set Strict-Transport-Security',
    'location /static/ does not set Content-Security-Policy',
    'location /static/ does not set X-Content-Type-Options',
    'location /static/ does not set Referrer-Policy',
    'location /static/ does not set Permissions-Policy',
  ]);
});

test('nginx: syntax errors are reported with their line', () => {
  assertFlags(checkNginx('http {\n  server {\n    listen 80\n  }\n'), [/not parseable: line \d+/]);
});

test('shell: strict mode, shebang, unsafe rm and backticks', () => {
  const problems = checkShellScript(fixture('bad.sh'));
  assertFlags(problems, [/not a bash shebang/, /not "set -euo pipefail"/, /line 4: rm -r on an unquoted variable/, /line 3: backtick/]);
});

test('shell: comments may precede set -euo pipefail', () => {
  assert.deepEqual(checkShellScript('#!/usr/bin/env bash\n# purpose\n\nset -euo pipefail\nrm -rf -- "$dir"\n'), []);
});

test('the command line checks individual files and exits 1 on problems', () => {
  const run = spawnSync(process.execPath, ['scripts/check.mjs', 'test/fixtures/Dockerfile.unpinned', 'nginx/nginx.conf'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  assert.equal(run.status, 1);
  assert.match(run.stdout, /FAIL {2}test\/fixtures\/Dockerfile\.unpinned\n {6}- base image "node:latest" uses the latest tag/);
  assert.match(run.stdout, /ok {4}nginx\/nginx\.conf/);
  assert.match(run.stdout, /1 of 2 files pass/);
});
