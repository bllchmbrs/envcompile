import { spawnFile } from './process.js';
import { dotenvxError } from './errors.js';
import { resolveDotenvxBin } from './dotenvx-bin.js';

export async function decryptFile({ dotenvxBin, filePath, privateKeys, envKeysFile, noOps = false }) {
  const args = ['decrypt', '-f', filePath];
  if (envKeysFile) args.push('-fk', envKeysFile);
  if (noOps) args.push('--no-ops');
  args.push('--stdout');

  const result = await spawnFile(resolveDotenvxBin(dotenvxBin), args, {
    env: {
      ...process.env,
      ...privateKeys,
    },
  });

  if (result.code !== 0) {
    throw dotenvxError(`dotenvx decrypt failed for ${filePath}\n${result.stderr.trim()}`);
  }

  return result.stdout;
}

export async function encryptFile({ dotenvxBin, filePath, cwd, envKeysFile, noOps = false }) {
  const args = ['encrypt', '-f', filePath];
  if (envKeysFile) args.push('-fk', envKeysFile);
  if (noOps) args.push('--no-ops');

  const result = await spawnFile(resolveDotenvxBin(dotenvxBin), args, {
    cwd,
    env: process.env,
  });

  if (result.code !== 0) {
    throw dotenvxError(`dotenvx encrypt failed for ${filePath}\n${result.stderr.trim()}`);
  }

  return result;
}
