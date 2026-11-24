// Parser for nginx configuration syntax: directives, blocks, quoted strings and
// comments, with `include` expanded through a caller-supplied resolver.

export class NginxSyntaxError extends Error {
  constructor(message, line) {
    super(`line ${line}: ${message}`);
    this.name = 'NginxSyntaxError';
    this.line = line;
  }
}

function tokenize(source) {
  const tokens = [];
  let line = 1;
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    if (c === '\n') {
      line += 1;
      i += 1;
    } else if (/\s/.test(c)) {
      i += 1;
    } else if (c === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
    } else if (c === '{' || c === '}' || c === ';') {
      tokens.push({ type: c, line });
      i += 1;
    } else if (c === '"' || c === "'") {
      const start = line;
      let value = '';
      i += 1;
      while (i < source.length && source[i] !== c) {
        if (source[i] === '\\' && i + 1 < source.length) {
          value += source[i + 1];
          i += 2;
          continue;
        }
        if (source[i] === '\n') line += 1;
        value += source[i];
        i += 1;
      }
      if (i >= source.length) throw new NginxSyntaxError('unterminated string', start);
      i += 1;
      tokens.push({ type: 'word', value, quoted: true, line: start });
    } else {
      let value = '';
      while (i < source.length && !/[\s{};]/.test(source[i])) {
        value += source[i];
        i += 1;
      }
      tokens.push({ type: 'word', value, line });
    }
  }
  return tokens;
}

/** Parse nginx configuration text into a tree of { name, args, line, children? }. */
export function parseNginx(source) {
  const tokens = tokenize(source);
  let pos = 0;

  function parseBlock(closing) {
    const nodes = [];
    while (pos < tokens.length) {
      const token = tokens[pos];
      if (token.type === '}') {
        if (!closing) throw new NginxSyntaxError('unexpected "}"', token.line);
        pos += 1;
        return nodes;
      }
      if (token.type !== 'word') throw new NginxSyntaxError(`unexpected "${token.type}"`, token.line);
      const node = { name: token.value, args: [], line: token.line };
      pos += 1;
      while (pos < tokens.length && tokens[pos].type === 'word') {
        node.args.push(tokens[pos].value);
        pos += 1;
      }
      const end = tokens[pos];
      if (!end) throw new NginxSyntaxError(`"${node.name}" is not terminated by ";"`, node.line);
      pos += 1;
      if (end.type === '{') node.children = parseBlock(true);
      else if (end.type !== ';') throw new NginxSyntaxError(`unexpected "${end.type}"`, end.line);
      nodes.push(node);
    }
    if (closing) throw new NginxSyntaxError('missing "}"', tokens.at(-1)?.line ?? 1);
    return nodes;
  }

  return parseBlock(false);
}

/**
 * Replace every `include` with the parsed contents of the files it names.
 * `resolve(pattern)` returns an array of file texts, or null when the include
 * points outside what is being checked (for example mime.types); those are kept.
 */
export function expandIncludes(nodes, resolve, depth = 0) {
  if (depth > 10) throw new Error('include nesting deeper than 10 levels');
  const out = [];
  for (const node of nodes) {
    if (node.name === 'include' && !node.children) {
      const texts = resolve ? resolve(node.args[0]) : null;
      if (texts) {
        for (const text of texts) out.push(...expandIncludes(parseNginx(text), resolve, depth + 1));
        continue;
      }
    }
    out.push(node.children ? { ...node, children: expandIncludes(node.children, resolve, depth) } : node);
  }
  return out;
}

/** Depth-first walk yielding [node, ancestors]. */
export function* walk(nodes, ancestors = []) {
  for (const node of nodes) {
    yield [node, ancestors];
    if (node.children) yield* walk(node.children, [...ancestors, node]);
  }
}
