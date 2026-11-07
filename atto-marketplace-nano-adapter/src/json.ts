const MAX_JSON_BYTES = 1_000_000;

function objectValue(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a JSON object');
  return value as Record<string, unknown>;
}

/** JSON.parse semantics with duplicate-field rejection, bounded depth, and no trailing tokens. */
export function parseJsonObject(text: string): Record<string, unknown> {
  if (Buffer.byteLength(text, 'utf8') > MAX_JSON_BYTES) throw new Error('JSON input exceeds its byte limit');
  // JSON.parse performs complete syntax validation. The second pass checks the
  // source keys before duplicate names can be discarded by object construction.
  const result = objectValue(JSON.parse(text));
  let offset = 0;
  const stringToken = /"(?:[^"\\\x00-\x1f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"/y;
  const primitive = /(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/y;
  const whitespace = () => { while (/[\x20\x09\x0a\x0d]/.test(text[offset] ?? '!')) offset++; };
  const quoted = (): string => {
    whitespace();
    stringToken.lastIndex = offset;
    const token = stringToken.exec(text);
    if (!token) throw new Error('Invalid JSON string');
    offset = stringToken.lastIndex;
    return JSON.parse(token[0]) as string;
  };
  const scan = (depth: number): void => {
    if (depth > 64) throw new Error('JSON nesting exceeds its limit');
    whitespace();
    const character = text[offset];
    if (character === '{') {
      offset++;
      whitespace();
      if (text[offset] === '}') { offset++; return; }
      const keys = new Set<string>();
      while (true) {
        const key = quoted();
        if (keys.has(key)) throw new Error('Duplicate JSON field');
        keys.add(key);
        whitespace();
        if (text[offset++] !== ':') throw new Error('Invalid JSON object');
        scan(depth + 1);
        whitespace();
        if (text[offset] === '}') { offset++; return; }
        if (text[offset++] !== ',') throw new Error('Invalid JSON object');
      }
    }
    if (character === '[') {
      offset++;
      whitespace();
      if (text[offset] === ']') { offset++; return; }
      while (true) {
        scan(depth + 1);
        whitespace();
        if (text[offset] === ']') { offset++; return; }
        if (text[offset++] !== ',') throw new Error('Invalid JSON array');
      }
    }
    if (character === '"') { quoted(); return; }
    primitive.lastIndex = offset;
    if (!primitive.exec(text)) throw new Error('Invalid JSON value');
    offset = primitive.lastIndex;
  };
  scan(0);
  whitespace();
  if (offset !== text.length) throw new Error('Trailing JSON input');
  return result;
}
