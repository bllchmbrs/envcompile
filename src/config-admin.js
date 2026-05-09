import fs from 'node:fs/promises';
import path from 'node:path';
import { findConfig, normalizeConfig } from './config.js';
import { configError } from './errors.js';

const SOURCE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const ENV_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

export function assertSourceName(name) {
  if (!name || !SOURCE_NAME_RE.test(name) || name.includes('..')) {
    throw configError(`Invalid source name "${name}". Use letters, numbers, dots, dashes, or underscores.`);
  }
}

export function assertEnvironmentName(name) {
  if (!name || !ENV_NAME_RE.test(name) || name.includes('..')) {
    throw configError(`Invalid environment name "${name}". Use letters, numbers, dots, dashes, or underscores.`);
  }
}

export async function updateEnvironment(cwd, explicitPath, options) {
  assertEnvironmentName(options.envName);
  const editable = await loadEditableConfig(cwd, explicitPath);
  const { config, configPath, isJson } = editable;
  let changed;

  if (isJson) {
    changed = updateJsonEnvironment(editable.raw, options);
  } else {
    changed = updateYamlEnvironment(editable.yaml, editable.yamlModule, options);
  }

  if (!changed) {
    return {
      changed: false,
      configPath,
      envName: options.envName,
      sourceDir: path.join(config.sourceDir, options.envName),
      publicDir: config.publicDir ? path.join(config.publicDir, options.envName) : null,
    };
  }

  const raw = editable.isJson ? editable.raw : editable.yaml.toJS();
  normalizeConfig(raw, path.dirname(configPath));
  await saveEditableConfig(editable);
  return {
    changed: true,
    configPath,
    envName: options.envName,
    sourceDir: path.join(config.sourceDir, options.envName),
    publicDir: config.publicDir ? path.join(config.publicDir, options.envName) : null,
  };
}

export async function listConfiguredSources(cwd, explicitPath, targetName) {
  const { config } = await loadEditableConfig(cwd, explicitPath);
  if (targetName && !config.targets[targetName]) {
    throw configError(`Unknown target "${targetName}". Available targets: ${Object.keys(config.targets).join(', ')}`);
  }

  const privateSources = new Map();
  const publicSources = new Map();
  const entries = targetName ? [[targetName, config.targets[targetName]]] : Object.entries(config.targets);

  for (const [name, target] of entries) {
    for (const source of target.sources) addUsage(privateSources, source, name);
    for (const source of target.publicSources) addUsage(publicSources, source, name);
  }

  return {
    privateSources: sortUsage(privateSources),
    publicSources: sortUsage(publicSources),
  };
}

export async function updateSourceMembership(cwd, explicitPath, options) {
  assertSourceName(options.sourceName);
  const editable = await loadEditableConfig(cwd, explicitPath);
  const { config, configPath, isJson } = editable;
  const target = config.targets[options.targetName];
  if (!target) {
    throw configError(`Unknown target "${options.targetName}". Available targets: ${Object.keys(config.targets).join(', ')}`);
  }
  if (options.publicSource && !config.publicDir) {
    throw configError('Cannot add public sources because publicDir is not configured.');
  }

  const field = options.publicSource ? 'publicSources' : 'sources';
  const type = options.publicSource ? 'public' : 'private';
  const updateOptions = {
    ...options,
    field,
    sourceName: options.sourceName,
  };
  let changed;

  if (isJson) {
    changed = updateJsonMembership(editable.raw, updateOptions);
  } else {
    changed = updateYamlMembership(editable.yaml, editable.yamlModule, updateOptions);
  }

  if (!changed) {
    return { changed: false, configPath, sourceName: options.sourceName, targetName: options.targetName, type };
  }

  const raw = editable.isJson ? editable.raw : editable.yaml.toJS();
  normalizeConfig(raw, path.dirname(configPath));
  await saveEditableConfig(editable);
  return { changed: true, configPath, sourceName: options.sourceName, targetName: options.targetName, type };
}

export async function loadEditableConfig(cwd, explicitPath) {
  const configPath = await findConfig(cwd, explicitPath);
  const text = await fs.readFile(configPath, 'utf8');
  const isJson = configPath.endsWith('.json');

  if (isJson) {
    const raw = JSON.parse(text);
    const config = normalizeConfig(raw, path.dirname(configPath));
    return { configPath, raw, config, isJson: true };
  }

  let yamlModule;
  try {
    yamlModule = await import('yaml');
  } catch {
    throw configError('YAML config requires the "yaml" package. Run npm install before editing envcompile.config.yaml.');
  }

  const yaml = yamlModule.parseDocument(text);
  if (yaml.errors.length > 0) {
    throw configError(`Invalid YAML config: ${yaml.errors[0].message}`);
  }
  const raw = yaml.toJS();
  const config = normalizeConfig(raw, path.dirname(configPath));
  return {
    configPath,
    raw,
    config,
    isJson: false,
    yaml,
    yamlModule,
  };
}

async function saveEditableConfig(editable) {
  if (editable.isJson) {
    await fs.writeFile(editable.configPath, `${JSON.stringify(editable.raw, null, 2)}\n`, 'utf8');
    return;
  }

  await fs.writeFile(editable.configPath, String(editable.yaml), 'utf8');
}

function addUsage(sources, source, targetName) {
  if (!sources.has(source)) sources.set(source, []);
  sources.get(source).push(targetName);
}

function sortUsage(sources) {
  return [...sources.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, targets]) => ({ name, targets: targets.sort() }));
}

function updateJsonEnvironment(raw, options) {
  if (!Array.isArray(raw.environments)) {
    throw configError('Config environments must be an array.');
  }
  if (raw.environments.map(String).includes(options.envName)) return false;
  raw.environments.push(options.envName);
  return true;
}

function updateYamlEnvironment(doc, yamlModule, options) {
  const { isSeq } = yamlModule;
  const seq = doc.get('environments', true);
  if (!isSeq(seq)) throw configError('Config environments must be an array.');

  const values = seq.items.map((item) => scalarToString(item));
  if (values.includes(options.envName)) return false;
  seq.add(options.envName);
  return true;
}

function updateJsonMembership(raw, options) {
  const target = raw.targets?.[options.targetName];
  if (!target || typeof target !== 'object' || Array.isArray(target)) {
    throw configError(`Target "${options.targetName}" must be an object.`);
  }
  if (!Array.isArray(target[options.field])) {
    target[options.field] = [];
  }

  const index = target[options.field].map(String).indexOf(options.sourceName);
  if (options.action === 'add') {
    if (index !== -1) return false;
    target[options.field].push(options.sourceName);
    return true;
  }

  if (index === -1) return false;
  if (options.field === 'sources' && target[options.field].length === 1) {
    throw configError(`Cannot remove the last private source from target "${options.targetName}".`);
  }
  target[options.field].splice(index, 1);
  return true;
}

function updateYamlMembership(doc, yamlModule, options) {
  const { isMap, isSeq } = yamlModule;
  const targets = doc.get('targets', true);
  if (!isMap(targets)) throw configError('Config targets must be a mapping.');
  const target = targets.get(options.targetName, true);
  if (!isMap(target)) throw configError(`Target "${options.targetName}" must be an object.`);

  let seq = target.get(options.field, true);
  if (!seq) {
    seq = doc.createNode([]);
    target.set(options.field, seq);
  }
  if (!isSeq(seq)) {
    throw configError(`Target "${options.targetName}" ${options.field} must be an array.`);
  }

  const values = seq.items.map((item) => scalarToString(item));
  const index = values.indexOf(options.sourceName);
  if (options.action === 'add') {
    if (index !== -1) return false;
    seq.add(options.sourceName);
    return true;
  }

  if (index === -1) return false;
  if (options.field === 'sources' && seq.items.length === 1) {
    throw configError(`Cannot remove the last private source from target "${options.targetName}".`);
  }
  seq.items.splice(index, 1);
  return true;
}

function scalarToString(item) {
  if (item && Object.prototype.hasOwnProperty.call(item, 'value')) {
    return String(item.value);
  }
  return String(item);
}
