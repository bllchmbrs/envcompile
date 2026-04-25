import { spawnFile } from './process.js';
import { dotenvxError } from './errors.js';
import { resolveDotenvxBin } from './dotenvx-bin.js';

export async function decryptFile({ dotenvxBin, filePath, privateKeys }) {
  const result = await spawnFile(resolveDotenvxBin(dotenvxBin), ['decrypt', '-f', filePath, '--stdout'], {
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

export async function encryptFile({ dotenvxBin, filePath, cwd }) {
  const result = await spawnFile(resolveDotenvxBin(dotenvxBin), ['encrypt', '-f', filePath], {
    cwd,
    env: process.env,
  });

  if (result.code !== 0) {
    throw dotenvxError(`dotenvx encrypt failed for ${filePath}\n${result.stderr.trim()}`);
  }

  return result;
}
