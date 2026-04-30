import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { configError, EnvcompileError } from './errors.js';
import { parseDotenv, parsePrivateKeys, stringifyDotenv, isPublicKeyName } from './dotenv.js';
import { decryptFile, encryptFile } from './dotenvx.js';
import { renderTemplate, resolveFrom } from './paths.js';

export async function validateConfig(config) {
  const results = [];

  // Check that sourceDir exists
  try {
    await fs.access(config.sourceDir);
  } catch {
    results.push({ label: 'sourceDir', ok: false, errors: [`Directory not found: ${config.sourceDir}`] });
  }

  // Check that keysDir exists
  try {
    await fs.access(config.keysDir);
  } catch {
    results.push({ label: 'keysDir', ok: false, errors: [`Directory not found: ${config.keysDir}`] });
  }

  // Check that publicDir exists (if configured)
  if (config.publicDir) {
    try {
      await fs.access(config.publicDir);
    } catch {
      results.push({ label: 'publicDir', ok: false, errors: [`Directory not found: ${config.publicDir}`] });
    }
  }

  // For each target × env, check source files and key files exist
  for (const [targetName, target] of Object.entries(config.targets)) {
    for (const env of config.environments) {
      const errors = [];

      for (const source of target.sources) {
        const sourceFile = resolveSourceFile(config, env, source);
        try {
          await fs.access(sourceFile);
        } catch {
          errors.push(`Missing source file: ${sourceFile}`);
        }

        const keyFile = resolveSourceKeyFile(config, env, source);
        try {
          await fs.access(keyFile);
        } catch {
          errors.push(`Missing source key file: ${keyFile}`);
        }
      }

      for (const source of target.publicSources) {
        const sourceFile = resolvePublicSourceFile(config, env, source);
        try {
          await fs.access(sourceFile);
        } catch {
          errors.push(`Missing public source file: ${sourceFile}`);
        }
      }

      // Check that target output directory is writable (parent exists)
      try {
        const outputFile = resolveTargetOutput(config, targetName, env);
        const outputDir = path.dirname(outputFile);
        // Just check the parent of the parent exists if the dir doesn't
        try {
          await fs.access(outputDir);
        } catch {
          // Not an error — compile creates it. Skip.
        }
      } catch (err) {
        // Per-env map missing entry
        errors.push(err.message);
      }

      // Check target key file resolution works
      try {
        resolveTargetKeyFile(config, targetName, env);
      } catch (err) {
        errors.push(err.message);
      }

      const label = `${targetName}/${env}`;
      if (errors.length > 0) {
        results.push({ label, ok: false, errors });
      } else {
        results.push({ label, ok: true, errors: [] });
      }
    }
  }

  return results;
}

export function isFileEncrypted(text) {
  return /^[A-Za-z_][A-Za-z0-9_]*\s*=\s*"?encrypted:/m.test(text);
}

function allSourceEnvPairs(config, options = {}) {
  const envs = options.env ? [options.env] : config.environments;
  const allSources = new Set();
  for (const target of Object.values(config.targets)) {
    for (const source of target.sources) allSources.add(source);
  }
  const sources = options.source ? [options.source] : [...allSources];

  if (options.env) assertEnvironment(config, options.env);
  if (options.source && !allSources.has(options.source)) {
    throw configError(`Unknown source "${options.source}". Available sources: ${[...allSources].join(', ')}`);
  }

  const pairs = [];
  for (const env of envs) {
    for (const source of sources) {
      pairs.push({ env, source });
    }
  }
  return pairs;
}

export async function encryptSources(config, options = {}) {
  const pairs = allSourceEnvPairs(config, options);
  const results = [];

  for (const { env, source } of pairs) {
    const sourceFile = resolveSourceFile(config, env, source);
    const text = await fs.readFile(sourceFile, 'utf8');

    if (isFileEncrypted(text)) {
      results.push({ env, source, skipped: true });
      continue;
    }

    await encryptFile({
      dotenvxBin: options.dotenvxBin,
      filePath: sourceFile,
      cwd: path.dirname(sourceFile),
    });

    // dotenvx writes keys to .env.keys in the source directory.
    // Move them to the location envcompile expects (keysDir pattern).
    const dotenvxKeysFile = path.join(path.dirname(sourceFile), '.env.keys');
    const expectedKeyFile = resolveSourceKeyFile(config, env, source);
    try {
      const keysContent = await fs.readFile(dotenvxKeysFile, 'utf8');
      await fs.mkdir(path.dirname(expectedKeyFile), { recursive: true });
      // Append if the key file already exists (multiple sources may share a dir)
      try {
        const existing = await fs.readFile(expectedKeyFile, 'utf8');
        await fs.writeFile(expectedKeyFile, existing + '\n' + keysContent, { mode: 0o600 });
      } catch {
        await fs.writeFile(expectedKeyFile, keysContent, { mode: 0o600 });
      }
      await fs.unlink(dotenvxKeysFile);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      // If dotenvx didn't create .env.keys, nothing to move
    }

    results.push({ env, source, skipped: false });
  }

  return results;
}

export async function decryptSources(config, options = {}) {
  const pairs = allSourceEnvPairs(config, options);
  const results = [];

  for (const { env, source } of pairs) {
    const sourceFile = resolveSourceFile(config, env, source);
    const sourceKeyFile = resolveSourceKeyFile(config, env, source);
    const text = await fs.readFile(sourceFile, 'utf8');

    if (!isFileEncrypted(text)) {
      results.push({ env, source, skipped: true });
      continue;
    }

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
    await fs.writeFile(sourceFile, decrypted, { mode: 0o600 });
    results.push({ env, source, skipped: false });
  }

  return results;
}

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

export function resolvePublicSourceFile(config, env, source) {
  return path.join(config.publicDir, env, `.env.${source}`);
}

export function resolveSourceKeyFile(config, env, source) {
  const rendered = renderTemplate(config.keyFilePatterns.source, { env, source });
  return resolveFrom(config.keysDir, rendered);
}

export function resolveTargetOutput(config, targetName, env, override) {
  const target = getTarget(config, targetName);
  const raw = override || (typeof target.output === 'object' ? resolveEnvMap(target.output, env, targetName, 'output') : target.output);
  const rendered = renderTemplate(raw, { env, target: targetName });
  return resolveFrom(config.configDir, rendered);
}

export function resolveTargetKeyFile(config, targetName, env) {
  const target = getTarget(config, targetName);
  const raw = typeof target.keyFile === 'object' ? resolveEnvMap(target.keyFile, env, targetName, 'keyFile') : target.keyFile;
  const rendered = renderTemplate(raw, { env, target: targetName });
  return resolveFrom(config.configDir, rendered);
}

function resolveEnvMap(map, env, targetName, field) {
  if (!(env in map)) {
    throw new EnvcompileError(`Target "${targetName}" has no ${field} entry for environment "${env}".`, 1);
  }
  return map[env];
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
    await assertReadable(sourceFile, `compile ${targetName}/${env}: missing source file "${source}"`);
    await assertReadable(sourceKeyFile, `compile ${targetName}/${env}: missing key file for source "${source}"`);

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

  // Load public (plaintext) sources
  for (const source of target.publicSources) {
    const sourceFile = resolvePublicSourceFile(config, env, source);
    await assertReadable(sourceFile, `compile ${targetName}/${env}: missing public source file "${source}"`);

    const text = await fs.readFile(sourceFile, 'utf8');
    const parsed = parseDotenv(text);

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

  const context = `${targetName}/${env}`;
  await assertWritableDestination(outputFile, options.force, `compile ${context}: output file`);
  await assertWritableDestination(keyFile, options.force, `compile ${context}: key file`);

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
