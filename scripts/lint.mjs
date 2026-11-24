#!/usr/bin/env node
// Whitespace lint for tracked text files: no trailing whitespace, no tabs, and a
// final newline. Uses `git ls-files` so ignored and untracked files are skipped.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function lintText(text) {
  const problems = [];
  if (text.length > 0 && !text.endsWith('\n')) problems.push('missing final newline');
  text.split('\n').forEach((line, index) => {
    if (/[ \t]+\r?$/.test(line)) problems.push(`line ${index + 1}: trailing whitespace`);
    if (line.includes('\t')) problems.push(`line ${index + 1}: tab character`);
  });
  return problems;
}

function trackedFiles() {
  return execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
}

function main() {
  let failures = 0;
  const files = trackedFiles();
  for (const file of files) {
    const buffer = readFileSync(file);
    if (buffer.includes(0)) continue; // binary
    for (const problem of lintText(buffer.toString('utf8'))) {
      console.log(`${file}: ${problem}`);
      failures += 1;
    }
  }
  console.log(failures ? `\n${failures} problem(s)` : `lint: ${files.length} files clean`);
  process.exitCode = failures ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
