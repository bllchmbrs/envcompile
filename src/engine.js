import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { configError, EnvcompileError } from './errors.js';
import { parseDotenv, parsePrivateKeys, stringifyDotenv, isPublicKeyName } from './dotenv.js';
import { decryptFile, encryptFile } from './dotenvx.js';
import { renderTemplate, resolveFrom } from './paths.js';

export function getTarget(config, targetName) {
  const target = config.targets[targetName];
  if (!target) {
    throw configError(`Unknown target "${targetName}". Available targets: ${Object.keys(config.targets).join(', ')}`);
  }
  return target;
}

export function assertEnvironment(config, env) {
  if (!config.environments.includes(env)) {
    throw configError(`Unknown environment "${env}". Available environments: ${config.environments.join(', ')}`);
  }
}

export function resolveSourceFile(config, env, source) {
  return path.join(config.sourceDir, env, `.env.${source}`);
}

export function resolveSourceKeyFile(config, env, source) {
  const rendered = renderTemplate(config.keyFilePatterns.source, { env, source });
  return resolveFrom(config.keysDir, rendered);
}

export function resolveTargetOutput(config, targetName, env, override) {
  const target = getTarget(config, targetName);
  const rendered = renderTemplate(override || target.output, { env, target: targetName });
  return resolveFrom(config.configDir, rendered);
}

export function resolveTargetKeyFile(config, targetName, env) {
  const target = getTarget(config, targetName);
  const rendered = renderTemplate(target.keyFile, { env, target: targetName });
  return resolveFrom(config.keysDir, rendered);
}

export async function loadComposedTarget(config, targetName, env, options = {}) {
  assertEnvironment(config, env);
  const target = getTarget(config, targetName);
  const diagnostics = [];
  const entries = [];
  const seen = new Map();

  for (const source of target.sources) {
    const sourceFile = resolveSourceFile(config, env, source);
    const sourceKeyFile = resolveSourceKeyFile(config, env, source);
    await assertReadable(sourceFile, `Missing source file for ${env}/${source}`);
    await assertReadable(sourceKeyFile, `Missing key file for ${env}/${source}`);

    const keyText = await fs.readFile(sourceKeyFile, 'utf8');
    const privateKeys = parsePrivateKeys(keyText);
    if (Object.keys(privateKeys).length === 0) {
      throw new EnvcompileError(`No DOTENV_PRIVATE_KEY entries found in ${sourceKeyFile}`, 1);
    }

    const decrypted = await decryptFile({
      dotenvxBin: options.dotenvxBin,
      filePath: sourceFile,
      privateKeys,
    });
    const parsed = parseDotenv(decrypted);

    for (const [key, value] of Object.entries(parsed)) {
      if (isPublicKeyName(key)) continue;
      if (seen.has(key)) {
        diagnostics.push({
          type: 'duplicate',
          key,
          firstSource: seen.get(key).source,
          secondSource: source,
        });
        if (target.duplicatePolicy === 'error') continue;
        if (target.duplicatePolicy === 'last-wins') {
          const original = seen.get(key);
          entries[original.index] = null;
          seen.set(key, { source, index: entries.length });
          entries.push([key, value, source]);
        }
        continue;
      }

      seen.set(key, { source, index: entries.length });
      entries.push([key, value, source]);
    }
  }

  const activeEntries = entries.filter(Boolean).map(([key, value]) => [key, value]);
  const keys = new Set(activeEntries.map(([key]) => key));
  const missingRequired = target.required.filter((key) => !keys.has(key));
  for (const key of missingRequired) {
    diagnostics.push({ type: 'missing-required', key });
  }

  if (target.ordering === 'alpha') {
    activeEntries.sort(([a], [b]) => a.localeCompare(b));
  }

  return {
    targetName,
    env,
    target,
    entries: activeEntries,
    diagnostics,
    ok: diagnostics.every((item) => item.type !== 'duplicate' || target.duplicatePolicy !== 'error')
      && missingRequired.length === 0,
  };
}

export async function compileTarget(config, targetName, env, options = {}) {
  const composed = await loadComposedTarget(config, targetName, env, options);
  if (!composed.ok) {
    throw new EnvcompileError(formatDiagnostics(composed), 1);
  }

  const outputFile = resolveTargetOutput(config, targetName, env, options.out);
  const keyFile = resolveTargetKeyFile(config, targetName, env);

  if (options.dryRun) {
    return { ...composed, outputFile, keyFile, dryRun: true };
  }

  await assertWritableDestination(outputFile, options.force, 'output');
  await assertWritableDestination(keyFile, options.force, 'target key file');

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'envcompile-'));
  try {
    const tempEnvFile = path.join(tempDir, path.basename(outputFile));
    await fs.writeFile(tempEnvFile, stringifyDotenv(composed.entries), { mode: 0o600 });
    await encryptFile({
      dotenvxBin: options.dotenvxBin,
      filePath: tempEnvFile,
      cwd: tempDir,
    });

    await fs.mkdir(path.dirname(outputFile), { recursive: true });
    await fs.mkdir(path.dirname(keyFile), { recursive: true, mode: 0o700 });
    await fs.copyFile(tempEnvFile, outputFile);
    await fs.chmod(outputFile, 0o600);

    const generatedKeyFile = path.join(tempDir, '.env.keys');
    await fs.copyFile(generatedKeyFile, keyFile);
    await fs.chmod(keyFile, 0o600);

    const privateKeys = parsePrivateKeys(await fs.readFile(keyFile, 'utf8'));
    return {
      ...composed,
      outputFile,
      keyFile,
      privateKeys,
      dryRun: false,
    };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

export async function checkTargets(config, options = {}) {
  const targetNames = options.targetName ? [options.targetName] : Object.keys(config.targets);
  const envs = options.env ? [options.env] : config.environments;
  const results = [];

  for (const targetName of targetNames) {
    getTarget(config, targetName);
    for (const env of envs) {
      try {
        const composed = await loadComposedTarget(config, targetName, env, options);
        results.push({ targetName, env, ok: composed.ok, diagnostics: composed.diagnostics });
      } catch (error) {
        results.push({
          targetName,
          env,
          ok: false,
          diagnostics: [{ type: 'error', message: error.message }],
        });
      }
    }
  }

  return results;
}

export async function lintTargets(config, options = {}) {
  const targetNames = options.targetName ? [options.targetName] : Object.keys(config.targets);
  const envs = options.env ? [options.env] : config.environments;
  const results = [];

  for (const targetName of targetNames) {
    getTarget(config, targetName);
    for (const env of envs) {
      try {
        const composed = await loadComposedTarget(config, targetName, env, options);
        const diagnostics = composed.diagnostics.filter((item) => item.type === 'duplicate');
        results.push({
          targetName,
          env,
          ok: diagnostics.length === 0 || !options.strict,
          diagnostics,
          duplicatePolicy: composed.target.duplicatePolicy,
        });
      } catch (error) {
        results.push({
          targetName,
          env,
          ok: false,
          diagnostics: [{ type: 'error', message: error.message }],
          duplicatePolicy: null,
        });
      }
    }
  }

  return results;
}

export async function compareTarget(config, targetName, options = {}) {
  const envs = options.envs || config.environments;
  const snapshots = [];

  for (const env of envs) {
    const composed = options.source
      ? await loadSyntheticSource(config, options.source, env, options)
      : await loadComposedTarget(config, targetName, env, options);
    snapshots.push({ env, composed });
  }

  const allKeys = new Set();
  for (const snapshot of snapshots) {
    for (const [key] of snapshot.composed.entries) allKeys.add(key);
  }

  return {
    targetName: targetName || null,
    source: options.source || null,
    envs,
    keys: [...allKeys].sort(),
    snapshots,
  };
}

export function formatDiagnostics(composed) {
  const lines = [`${composed.targetName}/${composed.env} failed validation:`];
  for (const item of composed.diagnostics) {
    if (item.type === 'duplicate') {
      lines.push(`- duplicate ${item.key}: ${item.firstSource} and ${item.secondSource}`);
    } else if (item.type === 'missing-required') {
      lines.push(`- missing required ${item.key}`);
    } else if (item.type === 'error') {
      lines.push(`- ${item.message}`);
    }
  }
  return lines.join('\n');
}

async function loadSyntheticSource(config, source, env, options) {
  const syntheticConfig = {
    ...config,
    targets: {
      [`source:${source}`]: {
        sources: [source],
        output: '',
        keyFile: '',
        required: [],
        duplicatePolicy: 'error',
        ordering: 'alpha',
      },
    },
  };
  return loadComposedTarget(syntheticConfig, `source:${source}`, env, options);
}

async function assertReadable(filePath, message) {
  try {
    await fs.access(filePath);
  } catch {
    throw new EnvcompileError(`${message}: ${filePath}`, 1);
  }
}

async function assertWritableDestination(filePath, force, label) {
  try {
    await fs.access(filePath);
    if (!force) {
      throw new EnvcompileError(`${label} already exists: ${filePath}. Use --force to overwrite.`, 1);
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}
