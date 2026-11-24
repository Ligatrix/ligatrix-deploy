import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lintText } from '../scripts/lint.mjs';

test('lint accepts clean text and flags whitespace problems with line numbers', () => {
  assert.deepEqual(lintText('a\nb\n'), []);
  assert.deepEqual(lintText(''), []);
  assert.deepEqual(lintText('a \n\tb\nc'), [
    'missing final newline',
    'line 1: trailing whitespace',
    'line 2: tab character',
  ]);
});
