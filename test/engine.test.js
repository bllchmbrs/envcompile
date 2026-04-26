import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { compileTarget, lintTargets, loadComposedTarget } from '../src/engine.js';

test('loadComposedTarget merges decrypted source files and validates required keys', async () => {
  const fixture = await makeFixture();
  const composed = await loadComposedTarget(fixture.config, 'api', 'dev', {
    dotenvxBin: fixture.dotenvxBin,
  });

  assert.equal(composed.ok, true);
  assert.deepEqual(composed.entries, [
    ['STRIPE_SECRET_KEY', 'sk_dev'],
    ['CLOUDFLARE_API_TOKEN', 'cf_dev'],
  ]);
});

test('loadComposedTarget reports duplicates when duplicatePolicy is error', async () => {
  const fixture = await makeFixture({
    cloudflare: 'STRIPE_SECRET_KEY=duplicate\nCLOUDFLARE_API_TOKEN=cf_dev\n',
  });

  const composed = await loadComposedTarget(fixture.config, 'api', 'dev', {
    dotenvxBin: fixture.dotenvxBin,
  });

  assert.equal(composed.ok, false);
  assert.equal(composed.diagnostics[0].type, 'duplicate');
});

test('lintTargets warns on duplicates allowed by duplicatePolicy', async () => {
  const fixture = await makeFixture({
    cloudflare: 'STRIPE_SECRET_KEY=duplicate\nCLOUDFLARE_API_TOKEN=cf_dev\n',
    duplicatePolicy: 'first-wins',
  });

  const [result] = await lintTargets(fixture.config, {
    dotenvxBin: fixture.dotenvxBin,
  });

  assert.equal(result.ok, true);
  assert.equal(result.duplicatePolicy, 'first-wins');
  assert.deepEqual(result.diagnostics, [{
    type: 'duplicate',
    key: 'STRIPE_SECRET_KEY',
    firstSource: 'stripe',
    secondSource: 'cloudflare',
  }]);
});

test('lintTargets strict mode fails on duplicate keys', async () => {
  const fixture = await makeFixture({
    cloudflare: 'STRIPE_SECRET_KEY=duplicate\nCLOUDFLARE_API_TOKEN=cf_dev\n',
    duplicatePolicy: 'first-wins',
  });

  const [result] = await lintTargets(fixture.config, {
    dotenvxBin: fixture.dotenvxBin,
    strict: true,
  });

  assert.equal(result.ok, false);
  assert.equal(result.diagnostics[0].type, 'duplicate');
});

test('compileTarget writes encrypted output and generated key file', async () => {
  const fixture = await makeFixture();
  const result = await compileTarget(fixture.config, 'api', 'dev', {
    dotenvxBin: fixture.dotenvxBin,
  });

  assert.equal(result.dryRun, false);
  assert.match(await fs.readFile(result.outputFile, 'utf8'), /DOTENV_PUBLIC_KEY/);
  assert.deepEqual(result.privateKeys, {
    DOTENV_PRIVATE_KEY_API: 'private',
  });
});

async function makeFixture(overrides = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'envcompile-test-'));
  const sourceDir = path.join(root, 'source_env_vars');
  const keysDir = path.join(root, 'keys');
  await fs.mkdir(path.join(sourceDir, 'dev'), { recursive: true });
  await fs.mkdir(path.join(keysDir, 'dev'), { recursive: true });

  await fs.writeFile(path.join(sourceDir, 'dev/.env.stripe'), overrides.stripe || 'STRIPE_SECRET_KEY=sk_dev\n');
  await fs.writeFile(path.join(sourceDir, 'dev/.env.cloudflare'), overrides.cloudflare || 'CLOUDFLARE_API_TOKEN=cf_dev\n');
  await fs.writeFile(path.join(keysDir, 'dev/.env.stripe.keys'), 'DOTENV_PRIVATE_KEY_STRIPE=private\n');
  await fs.writeFile(path.join(keysDir, 'dev/.env.cloudflare.keys'), 'DOTENV_PRIVATE_KEY_CLOUDFLARE=private\n');

  const dotenvxBin = path.join(root, 'fake-dotenvx.js');
  await fs.writeFile(dotenvxBin, `#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const [command, flag, file] = process.argv.slice(2);
if (command === 'decrypt') {
  process.stdout.write(fs.readFileSync(file, 'utf8'));
  process.exit(0);
}
if (command === 'encrypt') {
  const text = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, 'DOTENV_PUBLIC_KEY="public"\\n' + text);
  fs.writeFileSync(path.join(process.cwd(), '.env.keys'), 'DOTENV_PRIVATE_KEY_API="private"\\n');
  process.exit(0);
}
process.exit(9);
`);
  await fs.chmod(dotenvxBin, 0o755);

  return {
    dotenvxBin,
    config: {
      version: 1,
      configDir: root,
      sourceDir,
      keysDir,
      environments: ['dev'],
      keyFilePatterns: {
        source: '{env}/.env.{source}.keys',
        target: 'targets/{env}/.env.{target}.keys',
      },
      targets: {
        api: {
          description: '',
          sources: ['stripe', 'cloudflare'],
          output: 'compiled_env/{env}/.env.api',
          keyFile: 'targets/{env}/.env.api.keys',
          required: ['STRIPE_SECRET_KEY', 'CLOUDFLARE_API_TOKEN'],
          duplicatePolicy: overrides.duplicatePolicy || 'error',
          ordering: 'config',
        },
      },
    },
  };
}
