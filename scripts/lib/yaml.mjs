// A small parser for the YAML subset that Compose files use: block mappings and
// sequences, plain and quoted scalars, flow sequences and mappings of scalars,
// and literal/folded block scalars. Anchors, aliases, merge keys, tags and
// multi-document streams are rejected with a clear error rather than misread.

export class YamlError extends Error {
  constructor(message, line) {
    super(line ? `line ${line}: ${message}` : message);
    this.name = 'YamlError';
    this.line = line;
  }
}

const KEY = /^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^\s"'#\-[{][^:]*?|-[^\s:][^:]*?)\s*:(?:\s+(.*))?$/;
const BLOCK_INDICATOR = /(?:^|:\s+|^-\s+)([|>])[-+]?$/;

function leadingSpaces(text) {
  return text.length - text.trimStart().length;
}

function stripComment(text) {
  let single = false;
  let double = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (c === "'" && !double) single = !single;
    else if (c === '"' && !single && text[i - 1] !== '\\') double = !double;
    else if (c === '#' && !single && !double && (i === 0 || /\s/.test(text[i - 1]))) {
      return text.slice(0, i).trimEnd();
    }
  }
  return text.trimEnd();
}

function tokenize(source) {
  const raw = source.split(/\r?\n/);
  const lines = [];
  let started = false;
  for (let i = 0; i < raw.length; i += 1) {
    const line = raw[i];
    const no = i + 1;
    if (/^\s*(#.*)?$/.test(line)) continue;
    if (/^ *\t/.test(line)) throw new YamlError('tabs are not allowed for indentation', no);
    if (line === '---') {
      if (started) throw new YamlError('multiple documents are not supported', no);
      continue;
    }
    started = true;
    const indent = leadingSpaces(line);
    const text = stripComment(line.slice(indent));
    const token = { no, indent, text };

    const block = BLOCK_INDICATOR.exec(text);
    if (block) {
      const body = [];
      let j = i + 1;
      while (j < raw.length && (raw[j].trim() === '' || leadingSpaces(raw[j]) > indent)) {
        body.push(raw[j]);
        j += 1;
      }
      while (body.length && body.at(-1).trim() === '') body.pop();
      const depth = Math.min(...body.filter((l) => l.trim()).map(leadingSpaces));
      const content = body.map((l) => l.slice(depth));
      token.block = block[1] === '|'
        ? `${content.join('\n')}\n`
        : `${content.map((l) => l.trim()).join(' ').replace(/\s+/g, ' ').trim()}\n`;
      i = j - 1;
    }
    lines.push(token);
  }
  return lines;
}

function splitFlow(inner, no) {
  const parts = [];
  let depth = 0;
  let quote = null;
  let current = '';
  for (const c of inner) {
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '[' || c === '{') depth += 1;
    else if (c === ']' || c === '}') depth -= 1;
    else if (c === ',' && depth === 0) {
      parts.push(current.trim());
      current = '';
      continue;
    }
    current += c;
  }
  if (quote || depth !== 0) throw new YamlError('unbalanced flow collection', no);
  if (current.trim()) parts.push(current.trim());
  return parts;
}

export function parseScalar(input, no) {
  const s = input.trim();
  if (s.startsWith('&') || s.startsWith('*')) throw new YamlError('anchors and aliases are not supported', no);
  if (s.startsWith('!')) throw new YamlError('tags are not supported', no);
  if (s.startsWith('"')) {
    if (!s.endsWith('"') || s.length < 2) throw new YamlError('unterminated double-quoted string', no);
    try {
      return JSON.parse(s.replace(/\\\$/g, '$'));
    } catch {
      throw new YamlError(`invalid double-quoted string ${s}`, no);
    }
  }
  if (s.startsWith("'")) {
    if (!s.endsWith("'") || s.length < 2) throw new YamlError('unterminated single-quoted string', no);
    return s.slice(1, -1).replaceAll("''", "'");
  }
  if (s.startsWith('[')) {
    if (!s.endsWith(']')) throw new YamlError('unterminated flow sequence', no);
    return splitFlow(s.slice(1, -1), no).map((part) => parseScalar(part, no));
  }
  if (s.startsWith('{')) {
    if (!s.endsWith('}')) throw new YamlError('unterminated flow mapping', no);
    const out = {};
    for (const part of splitFlow(s.slice(1, -1), no)) {
      const m = KEY.exec(part);
      if (!m) throw new YamlError(`expected key: value in flow mapping, got "${part}"`, no);
      out[parseScalar(m[1], no)] = m[2] === undefined ? null : parseScalar(m[2], no);
    }
    return out;
  }
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s === 'null' || s === '~' || s === '') return null;
  if (/^-?\d+$/.test(s)) return Number(s);
  if (/^-?\d+\.\d+$/.test(s)) return Number(s);
  return s;
}

export function parseYaml(source) {
  const lines = tokenize(source);
  let pos = 0;

  const isSeq = (text) => text === '-' || text.startsWith('- ');

  function parseNode(indent) {
    const line = lines[pos];
    if (isSeq(line.text)) return parseSeq(indent);
    if (KEY.test(line.text)) return parseMap(indent);
    pos += 1;
    return line.block ?? parseScalar(line.text, line.no);
  }

  function parseMap(indent) {
    const out = {};
    while (pos < lines.length && lines[pos].indent === indent) {
      const line = lines[pos];
      const m = KEY.exec(line.text);
      if (!m) throw new YamlError(`expected "key: value", got "${line.text}"`, line.no);
      const key = String(parseScalar(m[1], line.no));
      if (key === '<<') throw new YamlError('merge keys are not supported', line.no);
      if (Object.hasOwn(out, key)) throw new YamlError(`duplicate key "${key}"`, line.no);
      pos += 1;
      const rest = m[2];
      if (line.block !== undefined) out[key] = line.block;
      else if (rest !== undefined && rest !== '') out[key] = parseScalar(rest, line.no);
      else {
        const next = lines[pos];
        if (next && next.indent > indent) out[key] = parseNode(next.indent);
        else if (next && next.indent === indent && isSeq(next.text)) out[key] = parseSeq(indent);
        else out[key] = null;
      }
    }
    if (pos < lines.length && lines[pos].indent > indent) {
      throw new YamlError('unexpected indentation', lines[pos].no);
    }
    return out;
  }

  function parseSeq(indent) {
    const out = [];
    while (pos < lines.length && lines[pos].indent === indent && isSeq(lines[pos].text)) {
      const line = lines[pos];
      const rest = line.text === '-' ? '' : line.text.slice(1).trimStart();
      if (rest === '') {
        pos += 1;
        const next = lines[pos];
        out.push(next && next.indent > indent ? parseNode(next.indent) : null);
      } else if (KEY.test(rest) || isSeq(rest)) {
        // "- key: value": the item is a mapping (or sequence) starting on this line.
        const childIndent = indent + (line.text.length - rest.length);
        lines[pos] = { ...line, indent: childIndent, text: rest };
        out.push(parseNode(childIndent));
      } else {
        pos += 1;
        out.push(line.block ?? parseScalar(rest, line.no));
      }
    }
    return out;
  }

  if (lines.length === 0) return null;
  const root = parseNode(lines[0].indent);
  if (pos < lines.length) throw new YamlError('unexpected content after the document', lines[pos].no);
  return root;
}
