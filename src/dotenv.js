const DOTENV_PUBLIC_KEY_RE = /^DOTENV_PUBLIC_KEY(?:_[A-Z0-9_]+)?$/;
const DOTENV_PRIVATE_KEY_RE = /^DOTENV_PRIVATE_KEY(?:_[A-Z0-9_]+)?$/;

export function parseDotenv(text) {
  const env = {};
  const lines = String(text || '').split(/\r?\n/);

  for (const rawLine of lines) {
    let line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('export ')) line = line.slice(7).trim();

    const equalsIndex = findUnquotedEquals(line);
    if (equalsIndex === -1) continue;

    const key = line.slice(0, equalsIndex).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;

    const rawValue = line.slice(equalsIndex + 1).trim();
    env[key] = parseValue(rawValue);
  }

  return env;
}

export function parsePrivateKeys(text) {
  const parsed = parseDotenv(text);
  return Object.fromEntries(
    Object.entries(parsed).filter(([key]) => DOTENV_PRIVATE_KEY_RE.test(key)),
  );
}

export function isPublicKeyName(key) {
  return DOTENV_PUBLIC_KEY_RE.test(key);
}

export function stringifyDotenv(entries) {
  const lines = [];
  for (const [key, value] of entries) {
    if (isPublicKeyName(key)) continue;
    lines.push(`${key}=${quoteValue(value)}`);
  }
  return `${lines.join('\n')}\n`;
}

export function privateKeyExportName(target, env) {
  return `DOTENV_PRIVATE_KEY_${normalizeKeyPart(target)}_${normalizeKeyPart(env)}`;
}

function normalizeKeyPart(value) {
  return String(value).replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').toUpperCase();
}

function findUnquotedEquals(line) {
  let quote = null;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if ((char === '"' || char === "'") && line[index - 1] !== '\\') {
      quote = quote === char ? null : quote || char;
    }
    if (char === '=' && !quote) return index;
  }
  return -1;
}

function parseValue(rawValue) {
  if (!rawValue) return '';

  const first = rawValue[0];
  if (first === '"' || first === "'") {
    const end = findClosingQuote(rawValue, first);
    const body = end === -1 ? rawValue.slice(1) : rawValue.slice(1, end);
    return first === '"' ? unescapeDoubleQuoted(body) : body;
  }

  return stripInlineComment(rawValue).trim();
}

function findClosingQuote(value, quote) {
  for (let index = 1; index < value.length; index += 1) {
    if (value[index] === quote && value[index - 1] !== '\\') return index;
  }
  return -1;
}

function unescapeDoubleQuoted(value) {
  return value.replace(/\\([nrt"\\])/g, (_, char) => {
    if (char === 'n') return '\n';
    if (char === 'r') return '\r';
    if (char === 't') return '\t';
    return char;
  });
}

function stripInlineComment(value) {
  let quote = null;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if ((char === '"' || char === "'") && value[index - 1] !== '\\') {
      quote = quote === char ? null : quote || char;
    }
    if (char === '#' && !quote && /\s/.test(value[index - 1] || '')) {
      return value.slice(0, index);
    }
  }
  return value;
}

function quoteValue(value) {
  const text = String(value ?? '');
  const escaped = text
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')
    .replace(/"/g, '\\"');
  return `"${escaped}"`;
}
