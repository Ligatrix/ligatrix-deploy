#!/usr/bin/env node
// Static checks for the deployment templates. Each check takes file text and
// returns a list of problems (empty = pass), so the same rules run on this
// repository in CI and on deliberately broken fixtures in the test suite.
//
//   node scripts/check.mjs                     check this repository
//   node scripts/check.mjs path/to/checkout    check another checkout with the same layout
//   node scripts/check.mjs Dockerfile x.conf   check individual files (type from the name)

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseYaml } from './lib/yaml.mjs';
import { expandIncludes, parseNginx, walk } from './lib/nginx.mjs';

const SECRET_NAME = /(PASSWORD|PASSWD|SECRET|TOKEN|API_KEY|PRIVATE_KEY|ACCESS_KEY)/i;
const PLACEHOLDER = /^(|CHANGE_ME|changeme|<.*>)$/;

// ---------------------------------------------------------------- Dockerfile

function dockerInstructions(text) {
  const joined = text.replace(/\\\r?\n/g, ' ');
  return joined
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => {
      const [cmd, ...rest] = line.split(/\s+/);
      return { cmd: cmd.toUpperCase(), args: rest.join(' ') };
    });
}

function imageReference(fromArgs, globals) {
  const words = fromArgs.split(/\s+/).filter((w) => !w.startsWith('--'));
  const ref = words[0] ?? '';
  const alias = /^as$/i.test(words[1] ?? '') ? words[2] : null;
  const resolved = ref.replace(/\$\{(\w+)\}|\$(\w+)/g, (_, a, b) => globals[a ?? b] ?? '');
  return { ref: resolved, alias };
}

/** Classify an image reference: null when it is pinned, else the problem. */
export function imagePinProblem(ref) {
  if (!ref) return 'has no image';
  if (/@sha256:[0-9a-f]{64}$/.test(ref)) return null;
  const lastSegment = ref.split('/').at(-1);
  if (!lastSegment.includes(':')) return `"${ref}" has no tag (it means :latest)`;
  const tag = lastSegment.split(':').at(-1);
  if (tag === 'latest') return `"${ref}" uses the latest tag`;
  if (!tag) return `"${ref}" has an empty tag`;
  return null;
}

export function checkDockerfile(text) {
  const problems = [];
  const steps = dockerInstructions(text);
  const globals = {};
  const stages = [];
  let current = null;

  for (const step of steps) {
    if (step.cmd === 'ARG' && !current) {
      const [name, value = ''] = step.args.split('=');
      globals[name.trim()] = value.trim();
    }
    if (step.cmd === 'FROM') {
      const { ref, alias } = imageReference(step.args, globals);
      current = { ref, alias, steps: [] };
      stages.push(current);
      continue;
    }
    current?.steps.push(step);
  }

  if (stages.length === 0) return ['no FROM instruction'];
  const aliases = new Set(stages.map((s) => s.alias).filter(Boolean));
  for (const stage of stages) {
    if (aliases.has(stage.ref)) continue;
    const pin = imagePinProblem(stage.ref);
    if (pin) problems.push(`base image ${pin}; pin a version tag or digest`);
  }
  if (stages.length < 2) problems.push('single-stage build; use a separate build stage so build tools stay out of the image');

  const final = stages.at(-1);
  const users = final.steps.filter((s) => s.cmd === 'USER');
  const lastUser = users.at(-1)?.args.split(':')[0];
  if (!lastUser) problems.push('final stage has no USER; the container would run as root');
  else if (lastUser === 'root' || lastUser === '0') problems.push(`final stage runs as ${lastUser}`);

  const healthchecks = steps.filter((s) => s.cmd === 'HEALTHCHECK');
  if (healthchecks.length === 0) problems.push('no HEALTHCHECK');
  else if (/^NONE$/i.test(healthchecks.at(-1).args.trim())) problems.push('HEALTHCHECK is disabled');

  for (const step of steps) {
    if (step.cmd === 'ADD') problems.push(`ADD ${step.args}: use COPY (ADD fetches URLs and unpacks archives implicitly)`);
    if (step.cmd === 'ENV' || step.cmd === 'ARG') {
      for (const match of step.args.matchAll(/(\w+)=(\S*)/g)) {
        if (SECRET_NAME.test(match[1]) && match[2]) {
          problems.push(`${step.cmd} ${match[1]} bakes a secret into the image; pass it at run time`);
        }
      }
    }
  }

  const start = final.steps.filter((s) => s.cmd === 'CMD' || s.cmd === 'ENTRYPOINT').at(-1);
  if (start && !start.args.trim().startsWith('[')) {
    problems.push(`${start.cmd} uses shell form; use exec form ["..."] so the process receives SIGTERM`);
  }
  return problems;
}

export function checkDockerignore(text) {
  const entries = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  if (entries.includes('*') || entries.includes('**')) return [];
  const problems = [];
  for (const needed of ['.git', '.env', 'node_modules']) {
    if (!entries.some((e) => e.replace(/^\/|\/$/g, '').startsWith(needed))) {
      problems.push(`.dockerignore does not exclude ${needed}`);
    }
  }
  return problems;
}

// ------------------------------------------------------------------- Compose

function interpolateDefaults(value) {
  return String(value).replace(/\$\{(\w+)(?::?[-?]([^}]*))?\}/g, (_, _name, fallback) => fallback ?? '');
}

function isInterpolation(value) {
  return /^\$\{\w+(:?[-?][^}]*)?\}$/.test(String(value).trim());
}

function environmentEntries(environment) {
  if (!environment) return [];
  if (Array.isArray(environment)) {
    return environment.map((item) => {
      const [key, ...rest] = String(item).split('=');
      return [key, rest.length ? rest.join('=') : null];
    });
  }
  return Object.entries(environment);
}

export function checkCompose(text) {
  let doc;
  try {
    doc = parseYaml(text);
  } catch (error) {
    return [`not parseable: ${error.message}`];
  }
  if (!doc || typeof doc !== 'object' || !doc.services || typeof doc.services !== 'object') {
    return ['no services defined'];
  }

  const problems = [];
  const declaredVolumes = new Set(Object.keys(doc.volumes ?? {}));

  for (const [name, service] of Object.entries(doc.services)) {
    const where = `service "${name}"`;
    if (!service || typeof service !== 'object') {
      problems.push(`${where} is empty`);
      continue;
    }
    const onDemand = Array.isArray(service.profiles) && service.profiles.length > 0;

    // Health: every long-running service reports it, so depends_on and restarts work.
    const hc = service.healthcheck;
    const disabled = hc?.disable === true || (Array.isArray(hc?.test) && hc.test[0] === 'NONE');
    if (!onDemand && (!hc || !hc.test || disabled)) problems.push(`${where} has no healthcheck`);

    if (service.image !== undefined) {
      const pin = imagePinProblem(interpolateDefaults(service.image));
      if (pin) problems.push(`${where} image ${pin}`);
    } else if (!service.build) {
      problems.push(`${where} has neither image nor build`);
    }

    for (const [key, value] of environmentEntries(service.environment)) {
      if (value === null || value === undefined) continue;
      const text = String(value);
      if (SECRET_NAME.test(key) && !isInterpolation(text) && !/^\/run\/secrets\//.test(text)) {
        problems.push(`${where} sets ${key} in plain text; use \${${key}} from an env file or a secret`);
      }
      const userinfo = /^[a-z][a-z0-9+.-]*:\/\/[^:/@\s]+:([^@\s]+)@/i.exec(text);
      if (userinfo && !/^\$\{[^}]+\}$/.test(userinfo[1])) {
        problems.push(`${where} ${key} contains a password in plain text`);
      }
    }

    if (Array.isArray(service.depends_on)) {
      problems.push(`${where} depends_on is a plain list; use "condition: service_healthy" so it waits for readiness`);
    } else if (service.depends_on && typeof service.depends_on === 'object') {
      for (const [dep, spec] of Object.entries(service.depends_on)) {
        const condition = spec?.condition;
        if (condition !== 'service_healthy' && condition !== 'service_completed_successfully') {
          problems.push(`${where} depends on "${dep}" without condition: service_healthy`);
        }
      }
    }

    if (service.privileged === true) problems.push(`${where} runs privileged`);
    if (service.network_mode === 'host') problems.push(`${where} uses host networking`);

    const volumes = Array.isArray(service.volumes) ? service.volumes : [];
    for (const volume of volumes) {
      const spec = typeof volume === 'string' ? volume : `${volume.source ?? ''}:${volume.target ?? ''}`;
      if (spec.includes('docker.sock')) problems.push(`${where} mounts the Docker socket (root on the host)`);
      const source = spec.split(':')[0];
      if (source && !/^[./~$]/.test(source) && !declaredVolumes.has(source)) {
        problems.push(`${where} uses volume "${source}" that is not declared under top-level volumes`);
      }
    }

    const image = interpolateDefaults(service.image ?? '');
    if (/^(docker\.io\/)?(library\/)?postgres[:@]/.test(image) && !onDemand) {
      const data = volumes
        .map((v) => (typeof v === 'string' ? v.split(':') : [v.source, v.target]))
        .find(([, target]) => target === '/var/lib/postgresql/data');
      if (!data) problems.push(`${where} keeps Postgres data inside the container; mount a named volume at /var/lib/postgresql/data`);
      else if (/^[./~]/.test(data[0])) problems.push(`${where} stores Postgres data on a bind mount; use a named volume`);
    }
  }
  return problems;
}

export function checkEnvExample(text) {
  const problems = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    const value = m[2].trim().replace(/^["']|["']$/g, '');
    if (SECRET_NAME.test(m[1]) && !PLACEHOLDER.test(value)) {
      problems.push(`${m[1]} has a value; an example file holds placeholders only (CHANGE_ME)`);
    }
  }
  return problems;
}

// --------------------------------------------------------------------- nginx

export const REQUIRED_HEADERS = Object.freeze([
  'Strict-Transport-Security',
  'Content-Security-Policy',
  'X-Content-Type-Options',
  'Referrer-Policy',
  'Permissions-Policy',
]);

const MIN_HSTS_SECONDS = 15552000; // 180 days

function headersOf(children) {
  const headers = new Map();
  for (const node of children ?? []) {
    if (node.name === 'add_header') headers.set(node.args[0]?.toLowerCase(), node.args);
  }
  return headers;
}

function headerProblems(headers, where) {
  const problems = [];
  for (const header of REQUIRED_HEADERS) {
    const args = headers.get(header.toLowerCase());
    if (!args) {
      problems.push(`${where} does not set ${header}`);
      continue;
    }
    if (args.at(-1) !== 'always') problems.push(`${where} sets ${header} without "always" (missing on error responses)`);
  }
  const hsts = headers.get('strict-transport-security');
  if (hsts) {
    const age = Number(/max-age=(\d+)/.exec(hsts[1] ?? '')?.[1] ?? 0);
    if (age < MIN_HSTS_SECONDS) problems.push(`${where} HSTS max-age ${age} is below ${MIN_HSTS_SECONDS} (180 days)`);
  }
  const nosniff = headers.get('x-content-type-options');
  if (nosniff && nosniff[1] !== 'nosniff') problems.push(`${where} X-Content-Type-Options must be "nosniff"`);
  const csp = headers.get('content-security-policy');
  if (csp && !/default-src/.test(csp[1] ?? '')) problems.push(`${where} Content-Security-Policy has no default-src`);
  return problems;
}

/**
 * Check nginx configuration. `text` is the entry file; `resolveInclude` maps an
 * include argument to file texts (see expandIncludes).
 */
export function checkNginx(text, { resolveInclude } = {}) {
  let tree;
  try {
    tree = expandIncludes(parseNginx(text), resolveInclude);
  } catch (error) {
    return [`not parseable: ${error.message}`];
  }
  const problems = [];
  const all = [...walk(tree)];
  const named = (name) => all.filter(([node]) => node.name === name);
  const servers = named('server').map(([node]) => node).filter((node) => node.children);
  if (servers.length === 0) return ['no server block'];

  const listensTls = (server) => (server.children ?? []).some((n) => n.name === 'listen' && n.args.includes('ssl'));
  const tlsServers = servers.filter(listensTls);
  const plainServers = servers.filter((s) => !listensTls(s));
  if (tlsServers.length === 0) problems.push('no server listens with ssl');

  tlsServers.forEach((server, index) => {
    const where = `TLS server ${index + 1}`;
    problems.push(...headerProblems(headersOf(server.children), where));
    for (const [node] of walk(server.children ?? [])) {
      if (node.name === 'location' && headersOf(node.children).size > 0) {
        // add_header in a location replaces, not extends, the server's headers.
        problems.push(...headerProblems(headersOf(node.children), `location ${node.args.join(' ')}`));
      }
    }
  });

  plainServers.forEach((server, index) => {
    const redirects = [...walk(server.children ?? [])].some(([node]) =>
      node.name === 'return' && /^30[18]$/.test(node.args[0]) && /^https:\/\//.test(node.args[1] ?? ''));
    if (!redirects) problems.push(`plain HTTP server ${index + 1} does not redirect to https`);
    const proxies = [...walk(server.children ?? [])].some(([node]) => node.name === 'proxy_pass');
    if (proxies) problems.push(`plain HTTP server ${index + 1} proxies traffic without TLS`);
  });

  const tokensOff = named('server_tokens').some(([node]) => node.args[0] === 'off');
  if (!tokensOff) problems.push('server_tokens is not off (the version is advertised)');

  const protocols = named('ssl_protocols');
  if (tlsServers.length && protocols.length === 0) problems.push('ssl_protocols is not set');
  for (const [node] of protocols) {
    const weak = node.args.filter((p) => !['TLSv1.2', 'TLSv1.3'].includes(p));
    if (weak.length) problems.push(`ssl_protocols allows ${weak.join(', ')}`);
  }

  if (!named('gzip').some(([node]) => node.args[0] === 'on')) problems.push('gzip is not on');
  if (named('client_max_body_size').length === 0) problems.push('client_max_body_size is not set');

  if (named('limit_req_zone').length === 0) problems.push('no limit_req_zone defined');
  const authLimited = named('location').some(([node]) =>
    /auth|login|signin|password/.test(node.args.join(' ')) && (node.children ?? []).some((c) => c.name === 'limit_req'));
  if (!authLimited) problems.push('no auth or login location is rate limited with limit_req');

  const upstreams = named('upstream').map(([node]) => node);
  if (upstreams.length === 0) problems.push('no upstream block');
  for (const upstream of upstreams) {
    if (!(upstream.children ?? []).some((c) => c.name === 'keepalive')) {
      problems.push(`upstream ${upstream.args[0]} has no keepalive`);
    }
  }
  if (named('proxy_pass').length) {
    if (!named('proxy_http_version').some(([node]) => node.args[0] === '1.1')) {
      problems.push('proxy_http_version 1.1 is not set (upstream keepalive needs it)');
    }
    const clearsConnection = named('proxy_set_header').some(([node]) =>
      node.args[0]?.toLowerCase() === 'connection' && node.args[1] === '');
    if (!clearsConnection) problems.push('proxy_set_header Connection "" is not set (upstream keepalive needs it)');
  }
  return problems;
}

// --------------------------------------------------------------------- shell

export function checkShellScript(text) {
  const problems = [];
  const lines = text.split(/\r?\n/);
  if (!/^#!\s*(\/usr\/bin\/env bash|\/bin\/bash|\/usr\/bin\/bash)\s*$/.test(lines[0] ?? '')) {
    problems.push('first line is not a bash shebang (#!/usr/bin/env bash)');
  }
  const firstCommand = lines.slice(1).map((l) => l.trim()).find((l) => l && !l.startsWith('#'));
  if (!/^set -E?euo pipefail$/.test(firstCommand ?? '')) {
    problems.push(`first command is not "set -euo pipefail" (found "${firstCommand ?? ''}")`);
  }
  lines.forEach((line, index) => {
    const code = line.replace(/(^|\s)#.*$/, '');
    if (/\brm\s+-[a-zA-Z]*[rR][a-zA-Z]*\s+(--\s+)?\$/.test(code)) {
      problems.push(`line ${index + 1}: rm -r on an unquoted variable`);
    }
    if (/`[^`]*`/.test(code)) problems.push(`line ${index + 1}: backtick substitution; use $(...)`);
  });
  return problems;
}

// ---------------------------------------------------------------- repository

function nginxResolver(nginxDir) {
  return (pattern) => {
    if (!pattern?.startsWith('/etc/nginx/')) return null;
    const relative = pattern.slice('/etc/nginx/'.length);
    if (relative.includes('*')) {
      const dir = join(nginxDir, dirname(relative));
      const re = new RegExp(`^${basename(relative).replace(/[.]/g, '\\.').replace(/\*/g, '.*')}$`);
      if (!existsSync(dir)) return [];
      return readdirSync(dir).filter((f) => re.test(f)).sort().map((f) => readFileSync(join(dir, f), 'utf8'));
    }
    const file = join(nginxDir, relative);
    return existsSync(file) ? [readFileSync(file, 'utf8')] : null;
  };
}

/** Run every check over a checkout. Returns [{ file, problems }]. */
export function checkRepository(root) {
  const results = [];
  const read = (relative) => readFileSync(join(root, relative), 'utf8');
  const run = (file, fn) => {
    if (!existsSync(join(root, file))) results.push({ file, problems: ['file is missing'] });
    else results.push({ file, problems: fn(read(file)) });
  };

  run('docker/Dockerfile', checkDockerfile);
  run('.dockerignore', checkDockerignore);
  run('compose/compose.yaml', checkCompose);
  run('compose/.env.example', checkEnvExample);
  run('nginx/nginx.conf', (text) => checkNginx(text, { resolveInclude: nginxResolver(join(root, 'nginx')) }));

  const scriptsDir = join(root, 'scripts');
  const scripts = existsSync(scriptsDir) ? readdirSync(scriptsDir).filter((f) => f.endsWith('.sh')).sort() : [];
  for (const script of scripts) run(`scripts/${script}`, checkShellScript);
  return results;
}

/** Pick the check for a single file from its name, or null when unknown. */
export function checkerFor(file) {
  const name = basename(file);
  if (/^Dockerfile|\.Dockerfile$|^Dockerfile\./.test(name)) return checkDockerfile;
  if (name === '.dockerignore') return checkDockerignore;
  if (/\.ya?ml$/.test(name)) return checkCompose;
  if (/^\.env|\.example$/.test(name)) return checkEnvExample;
  if (/\.conf$/.test(name)) {
    return (text) => checkNginx(text, { resolveInclude: nginxResolver(dirname(resolvePath(file))) });
  }
  if (/\.sh$/.test(name)) return checkShellScript;
  return null;
}

function checkFiles(files) {
  return files.map((file) => {
    const fn = checkerFor(file);
    if (!fn) return { file, problems: ['unknown file type'] };
    if (!existsSync(file)) return { file, problems: ['file is missing'] };
    return { file, problems: fn(readFileSync(file, 'utf8')) };
  });
}

function main() {
  const args = process.argv.slice(2);
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
  const results = args.length === 0
    ? checkRepository(repoRoot)
    : args.length === 1 && existsSync(args[0]) && statSync(args[0]).isDirectory()
      ? checkRepository(resolvePath(args[0]))
      : checkFiles(args);
  let failed = 0;
  for (const { file, problems } of results) {
    if (problems.length === 0) {
      console.log(`ok    ${file}`);
      continue;
    }
    failed += 1;
    console.log(`FAIL  ${file}`);
    for (const problem of problems) console.log(`      - ${problem}`);
  }
  console.log(`\n${results.length - failed} of ${results.length} files pass`);
  process.exitCode = failed ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
