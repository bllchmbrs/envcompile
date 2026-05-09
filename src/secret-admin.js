import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from './config.js';
import { assertSourceName } from './config-admin.js';
import { parsePrivateKeys } from './dotenv.js';
import { decryptFile, encryptFile } from './dotenvx.js';
import {
  assertEnvironment,
  isFileEncrypted,
  resolvePublicSourceFile,
  resolveSourceFile,
  resolveSourceKeyFile,
} from './engine.js';
import { configError, EnvcompileError } from './errors.js';

const DOTENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export async function setSecret(cwd, explicitPath, options) {
  const { config } = await loadConfig(cwd, explicitPath);
  const type = resolveSecretType(config, options.sourceName, options);
  assertEnvironment(config, options.env);
  assertSecretKey(options.key);

  if (type === 'public') {
    const filePath = resolvePublicSourceFile(config, options.env, options.sourceName);
    await mutatePublicSecret(filePath, options.key, options.value, 'set');
    return { type, filePath };
  }

  return {
    type,
    ...(await mutatePrivateSecret(config, {
      ...options,
      action: 'set',
    })),
  };
}

export async function unsetSecret(cwd, explicitPath, options) {
  const { config } = await loadConfig(cwd, explicitPath);
  const type = resolveSecretType(config, options.sourceName, options);
  assertEnvironment(config, options.env);
  assertSecretKey(options.key);

  if (type === 'public') {
    const filePath = resolvePublicSourceFile(config, options.env, options.sourceName);
    await mutatePublicSecret(filePath, options.key, null, 'unset');
    return { type, filePath };
  }

  return {
    type,
    ...(await mutatePrivateSecret(config, {
      ...options,
      action: 'unset',
    })),
  };
}

export function resolveSecretType(config, sourceName, options = {}) {
  assertSourceName(sourceName);
  if (options.publicSource && options.privateSource) {
    throw configError('Choose only one of --public or --private.');
  }
  if (options.publicSource) {
    if (!config.publicDir) throw configError('Cannot use public secrets because publicDir is not configured.');
    return 'public';
  }
  if (options.privateSource) return 'private';

  const usage = findSourceUsage(config, sourceName);
  if (usage.privateTargets.length > 0 && usage.publicTargets.length > 0) {
    throw configError(`Source "${sourceName}" is both private and public. Use --private or --public.`);
  }
  if (usage.privateTargets.length > 0) return 'private';
  if (usage.publicTargets.length > 0) return 'public';

  throw configError(`Unknown source "${sourceName}". Use --private or --public for a new source.`);
}

export function assertSecretKey(key) {
  if (!key || !DOTENV_KEY_RE.test(key)) {
    throw configError(`Invalid secret key "${key}". Use a valid dotenv variable name.`);
  }
  if (/^DOTENV_(?:PUBLIC|PRIVATE)_KEY(?:_[A-Z0-9_]+)?$/.test(key)) {
    throw configError(`"${key}" is managed by dotenvx and cannot be set as a secret.`);
  }
}

async function mutatePublicSecret(filePath, key, value, action) {
  const text = await readOptionalFile(filePath);
  const next = action === 'set' ? setDotenvValue(text, key, value) : unsetDotenvValue(text, key);
  await writeAtomic(filePath, next, 0o644);
}

async function mutatePrivateSecret(config, options) {
  const sourceFile = resolveSourceFile(config, options.env, options.sourceName);
  const keyFile = resolveSourceKeyFile(config, options.env, options.sourceName);
  const sourceText = await readOptionalFile(sourceFile);
  const sourceExists = sourceText !== null;
  const keyText = await readOptionalFile(keyFile);
  const keyExists = keyText !== null;
  const beforeKeys = keyExists ? parsePrivateKeys(keyText) : {};

  if (keyExists && Object.keys(beforeKeys).length === 0) {
    throw new EnvcompileError(`No DOTENV_PRIVATE_KEY entries found in ${keyFile}`, 1);
  }
  if (sourceExists && isFileEncrypted(sourceText) && !keyExists) {
    throw new EnvcompileError(`Cannot edit encrypted source without key file: ${keyFile}`, 1);
  }
  if (options.action === 'unset' && !sourceExists) {
    throw new EnvcompileError(`Cannot unset ${options.key}; source file does not exist: ${sourceFile}`, 1);
  }

  const backup = sourceExists || keyExists
    ? await backupPrivateFiles(config, options.env, options.sourceName, sourceFile, keyFile, { sourceExists, keyExists })
    : null;

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'envcompile-secret-'));
  let restored = false;
  try {
    const tempEnvFile = path.join(tempDir, path.basename(sourceFile));
    const plaintext = sourceExists && isFileEncrypted(sourceText)
      ? await decryptFile({
        dotenvxBin: options.dotenvxBin,
        filePath: sourceFile,
        envKeysFile: keyFile,
        noOps: true,
      })
      : (sourceText || '');
    let nextPlaintext = options.action === 'set'
      ? setDotenvValue(plaintext, options.key, options.value)
      : unsetDotenvValue(plaintext, options.key);
    if (options.action === 'unset' && nextPlaintext.trim() === '') {
      nextPlaintext = '# envcompile: empty\n';
    }

    await fs.writeFile(tempEnvFile, nextPlaintext, { mode: 0o600 });
    await fs.mkdir(path.dirname(keyFile), { recursive: true, mode: 0o700 });
    await encryptFile({
      dotenvxBin: options.dotenvxBin,
      filePath: tempEnvFile,
      cwd: tempDir,
      envKeysFile: keyFile,
      noOps: true,
    });

    const afterKeys = parsePrivateKeys(await fs.readFile(keyFile, 'utf8'));
    const keyError = findKeyPreservationError(beforeKeys, afterKeys);
    if (keyError) {
      if (backup) {
        await restorePrivateBackup(backup, sourceFile, keyFile);
        restored = true;
      }
      throw new EnvcompileError(`${keyError} Restored original secret files from backup.`, 1);
    }

    await writeAtomic(sourceFile, await fs.readFile(tempEnvFile), 0o600);
    return { filePath: sourceFile, keyFile, backupDir: backup?.backupDir || null };
  } catch (error) {
    if (backup && !restored) {
      await restorePrivateBackup(backup, sourceFile, keyFile);
    } else if (!backup && !sourceExists && !keyExists) {
      await fs.rm(sourceFile, { force: true });
      await fs.rm(keyFile, { force: true });
    }
    throw error;
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

function findSourceUsage(config, sourceName) {
  const privateTargets = [];
  const publicTargets = [];
  for (const [targetName, target] of Object.entries(config.targets)) {
    if (target.sources.includes(sourceName)) privateTargets.push(targetName);
    if (target.publicSources.includes(sourceName)) publicTargets.push(targetName);
  }
  return { privateTargets, publicTargets };
}

async function readOptionalFile(filePath) {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function backupPrivateFiles(config, env, sourceName, sourceFile, keyFile, exists) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const suffix = `${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const backupDir = path.join(config.keysDir, '.envcompile-backups', `${timestamp}-${suffix}`, env, sourceName);
  await fs.mkdir(backupDir, { recursive: true, mode: 0o700 });

  const backup = {
    backupDir,
    sourceExists: exists.sourceExists,
    keyExists: exists.keyExists,
    sourceBackup: path.join(backupDir, path.basename(sourceFile)),
    keyBackup: path.join(backupDir, path.basename(keyFile)),
  };

  if (exists.sourceExists) {
    await fs.copyFile(sourceFile, backup.sourceBackup);
    await fs.chmod(backup.sourceBackup, 0o600);
  }
  if (exists.keyExists) {
    await fs.copyFile(keyFile, backup.keyBackup);
    await fs.chmod(backup.keyBackup, 0o600);
  }

  return backup;
}

async function restorePrivateBackup(backup, sourceFile, keyFile) {
  if (backup.sourceExists) {
    await fs.mkdir(path.dirname(sourceFile), { recursive: true });
    await fs.copyFile(backup.sourceBackup, sourceFile);
    await fs.chmod(sourceFile, 0o600);
  } else {
    await fs.rm(sourceFile, { force: true });
  }

  if (backup.keyExists) {
    await fs.mkdir(path.dirname(keyFile), { recursive: true, mode: 0o700 });
    await fs.copyFile(backup.keyBackup, keyFile);
    await fs.chmod(keyFile, 0o600);
  } else {
    await fs.rm(keyFile, { force: true });
  }
}

function findKeyPreservationError(beforeKeys, afterKeys) {
  for (const [name, value] of Object.entries(beforeKeys)) {
    if (!(name in afterKeys)) {
      return `Private key ${name} disappeared during secret update.`;
    }
    if (afterKeys[name] !== value) {
      return `Private key ${name} changed during secret update.`;
    }
  }
  return null;
}

function setDotenvValue(text, key, value) {
  const nextLine = `${key}=${quoteValue(value)}`;
  const lines = splitLines(text);
  const nextLines = [];
  let changed = false;
  for (const line of lines) {
    if (isKeyLine(line, key)) {
      if (!changed) nextLines.push(nextLine);
      changed = true;
      continue;
    }
    nextLines.push(line);
  }
  if (!changed) nextLines.push(nextLine);
  return `${nextLines.join('\n')}\n`;
}

function unsetDotenvValue(text, key) {
  const lines = splitLines(text).filter((line) => !isKeyLine(line, key));
  return lines.length > 0 ? `${lines.join('\n')}\n` : '';
}

function splitLines(text) {
  return String(text || '').replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n').filter((line, index, lines) => {
    return !(line === '' && index === lines.length - 1);
  });
}

function isKeyLine(line, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^\\s*(?:export\\s+)?${escaped}\\s*=`).test(line);
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

async function writeAtomic(filePath, content, mode) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempFile = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  await fs.writeFile(tempFile, content, { mode });
  await fs.chmod(tempFile, mode);
  await fs.rename(tempFile, filePath);
}
