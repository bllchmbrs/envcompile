import fs from 'node:fs/promises';
import path from 'node:path';
import { configError } from './errors.js';
import { resolveFrom } from './paths.js';

const CONFIG_NAMES = [
  'envcompile.config.yaml',
  'envcompile.config.yml',
  'envcompile.config.json',
];

export async function findConfig(cwd, explicitPath) {
  if (explicitPath) return resolveFrom(cwd, explicitPath);

  for (const name of CONFIG_NAMES) {
    const candidate = path.resolve(cwd, name);
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // Keep looking.
    }
  }

  throw configError(`No config file found. Expected one of: ${CONFIG_NAMES.join(', ')}`);
}

export async function loadConfig(cwd, explicitPath) {
  const configPath = await findConfig(cwd, explicitPath);
  const text = await fs.readFile(configPath, 'utf8');
  const raw = await parseConfigText(configPath, text);
  const config = normalizeConfig(raw, path.dirname(configPath));
  return { config, configPath };
}

export async function parseConfigText(configPath, text) {
  if (configPath.endsWith('.json')) {
    return JSON.parse(text);
  }

  let yaml;
  try {
    yaml = await import('yaml');
  } catch {
    throw configError('YAML config requires the "yaml" package. Run npm install before using envcompile.config.yaml.');
  }

  return yaml.parse(text);
}

export function normalizeConfig(raw, configDir) {
  if (!raw || typeof raw !== 'object') {
    throw configError('Config must be an object.');
  }
  if (raw.version !== 1) {
    throw configError('Config version must be 1.');
  }
  if (!raw.sourceDir) {
    throw configError('Config requires sourceDir.');
  }
  if (!raw.keysDir) {
    throw configError('Config requires keysDir.');
  }
  if (!Array.isArray(raw.environments) || raw.environments.length === 0) {
    throw configError('Config requires at least one environment.');
  }
  if (!raw.targets || typeof raw.targets !== 'object') {
    throw configError('Config requires targets.');
  }

  const sourceDir = resolveFrom(configDir, raw.sourceDir);
  const keysDir = resolveFrom(configDir, raw.keysDir);
  const keyFilePatterns = {
    source: '{env}/.env.{source}.keys',
    target: 'targets/{env}/.env.{target}.keys',
    ...(raw.keyFilePatterns || {}),
  };

  const targets = {};
  for (const [name, target] of Object.entries(raw.targets)) {
    if (!target || typeof target !== 'object') {
      throw configError(`Target "${name}" must be an object.`);
    }
    if (!Array.isArray(target.sources) || target.sources.length === 0) {
      throw configError(`Target "${name}" requires at least one source.`);
    }
    if (!target.output) {
      throw configError(`Target "${name}" requires output.`);
    }
    if (typeof target.output !== 'string' && (typeof target.output !== 'object' || Array.isArray(target.output))) {
      throw configError(`Target "${name}" output must be a string or an object mapping environments to paths.`);
    }
    if (target.keyFile && typeof target.keyFile !== 'string' && (typeof target.keyFile !== 'object' || Array.isArray(target.keyFile))) {
      throw configError(`Target "${name}" keyFile must be a string or an object mapping environments to paths.`);
    }
    const duplicatePolicy = target.duplicatePolicy || 'error';
    if (!['error', 'first-wins', 'last-wins'].includes(duplicatePolicy)) {
      throw configError(`Target "${name}" has invalid duplicatePolicy "${duplicatePolicy}".`);
    }
    const ordering = target.ordering || 'config';
    if (!['config', 'alpha'].includes(ordering)) {
      throw configError(`Target "${name}" has invalid ordering "${ordering}".`);
    }

    const normalizedOutput = typeof target.output === 'string'
      ? String(target.output)
      : Object.fromEntries(Object.entries(target.output).map(([k, v]) => [String(k), String(v)]));

    let normalizedKeyFile;
    if (!target.keyFile) {
      normalizedKeyFile = keyFilePatterns.target;
    } else if (typeof target.keyFile === 'string') {
      normalizedKeyFile = String(target.keyFile);
    } else {
      normalizedKeyFile = Object.fromEntries(Object.entries(target.keyFile).map(([k, v]) => [String(k), String(v)]));
    }

    targets[name] = {
      description: target.description || '',
      sources: target.sources.map(String),
      output: normalizedOutput,
      keyFile: normalizedKeyFile,
      required: Array.isArray(target.required) ? target.required.map(String) : [],
      duplicatePolicy,
      ordering,
    };
  }

  return {
    version: 1,
    configDir,
    sourceDir,
    keysDir,
    environments: raw.environments.map(String),
    keyFilePatterns,
    targets,
  };
}
