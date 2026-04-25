import os from 'node:os';
import path from 'node:path';

export function expandHome(value) {
  if (!value || typeof value !== 'string') return value;
  if (value === '~') return os.homedir();
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2));
  return value;
}

export function renderTemplate(template, values) {
  return template.replace(/\{([A-Za-z0-9_]+)\}/g, (_, key) => {
    if (!(key in values)) {
      throw new Error(`Unknown template variable {${key}} in ${template}`);
    }
    return String(values[key]);
  });
}

export function resolveFrom(baseDir, maybeRelativePath) {
  const expanded = expandHome(maybeRelativePath);
  if (path.isAbsolute(expanded)) return path.normalize(expanded);
  return path.resolve(baseDir, expanded);
}

export function toDisplayPath(filePath) {
  const home = os.homedir();
  if (filePath === home) return '~';
  if (filePath.startsWith(`${home}${path.sep}`)) {
    return `~/${path.relative(home, filePath)}`;
  }
  return filePath;
}
