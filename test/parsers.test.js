import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseYaml } from '../scripts/lib/yaml.mjs';
import { expandIncludes, parseNginx } from '../scripts/lib/nginx.mjs';

test('yaml: nested mappings, sequences of mappings and scalars', () => {
  const doc = parseYaml([
    'name: demo # trailing comment',
    'services:',
    '  app:',
    '    ports:',
    '      - "80:8080"',
    '    env:',
    '    - name: A',
    '      value: 1',
    '    flags: [CMD, "a b", \'c\']',
    '    empty: {}',
    '    on: true',
    '    off: null',
    '',
  ].join('\n'));
  assert.deepEqual(doc, {
    name: 'demo',
    services: {
      app: {
        ports: ['80:8080'],
        env: [{ name: 'A', value: 1 }],
        flags: ['CMD', 'a b', 'c'],
        empty: {},
        on: true,
        off: null,
      },
    },
  });
});

test('yaml: block scalars keep or fold lines', () => {
  const doc = parseYaml('a: |\n  one\n  two\nb: >\n  one\n  two\nc: x\n');
  assert.deepEqual(doc, { a: 'one\ntwo\n', b: 'one two\n', c: 'x' });
});

test('yaml: hash inside quotes and URLs is not a comment', () => {
  const doc = parseYaml('a: "x # y"\nb: http://host/#frag\n');
  assert.deepEqual(doc, { a: 'x # y', b: 'http://host/#frag' });
});

test('yaml: duplicate keys, tabs, merge keys and bad indentation are errors', () => {
  assert.throws(() => parseYaml('a: 1\na: 2\n'), /line 2: duplicate key "a"/);
  assert.throws(() => parseYaml('a:\n\tb: 1\n'), /tabs are not allowed/);
  assert.throws(() => parseYaml('a:\n  <<: {}\n'), /merge keys are not supported/);
  assert.throws(() => parseYaml('a:\n    b: 1\n  c: 2\n'), /unexpected/);
});

test('nginx: blocks, quoted arguments and comments', () => {
  const tree = parseNginx('# top\nhttp {\n  add_header X-A "a; b" always; # note\n  server { listen 80; }\n}\n');
  assert.equal(tree[0].name, 'http');
  assert.deepEqual(tree[0].children[0].args, ['X-A', 'a; b', 'always']);
  assert.deepEqual(tree[0].children[1].children[0], { name: 'listen', args: ['80'], line: 4 });
});

test('nginx: includes are expanded in place; unresolved ones are kept', () => {
  const files = { '/etc/nginx/snippets/h.conf': 'add_header X-B "b" always;' };
  const tree = expandIncludes(
    parseNginx('server { include /etc/nginx/snippets/h.conf; include mime.types; }'),
    (path) => (files[path] ? [files[path]] : null),
  );
  assert.deepEqual(tree[0].children.map((n) => n.name), ['add_header', 'include']);
});

test('nginx: unbalanced braces and unterminated strings are errors', () => {
  assert.throws(() => parseNginx('http {\n'), /missing "}"/);
  assert.throws(() => parseNginx('}'), /unexpected "}"/);
  assert.throws(() => parseNginx('add_header X "open;\n'), /line 1: unterminated string/);
});
