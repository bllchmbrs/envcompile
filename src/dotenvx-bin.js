import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function resolveDotenvxBin(override) {
  if (override) return override;

  try {
    const packageJsonPath = fileURLToPath(import.meta.resolve('@dotenvx/dotenvx/package.json'));
    const packageDir = path.dirname(packageJsonPath);
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    const binPath = packageJson.bin?.dotenvx;
    if (binPath) {
      const resolved = path.resolve(packageDir, binPath);
      if (fs.existsSync(resolved)) return resolved;
    }
  } catch {
    // Fall back to PATH for development checkouts or unusual package managers.
  }

  return 'dotenvx';
}
