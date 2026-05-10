import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseDotenv, parsePrivateKeys } from '../src/dotenv.js';
import { decryptFile } from '../src/dotenvx.js';
import { parseArgs, main } from '../src/cli.js';
import { resolveSecretType } from '../src/secret-admin.js';

test('parseArgs supports positional arguments and long options', () => {
  assert.deepEqual(parseArgs(['compile', 'api', '--env', 'prod', '--dry-run', '--out=deploy/.env']), {
    command: 'compile',
    positional: ['api'],
    options: {
      env: 'prod',
      dryRun: true,
      out: 'deploy/.env',
    },
  });
});

test('parseArgs supports lint strict flag', () => {
  assert.deepEqual(parseArgs(['lint', 'api', '--env', 'prod', '--strict']), {
    command: 'lint',
    positional: ['api'],
    options: {
      env: 'prod',
      strict: true,
    },
  });
});

test('secret type resolves standalone configured sources', () => {
  const config = {
    publicDir: '/public',
    sources: ['billing'],
    publicSources: ['defaults'],
    targets: {},
  };

  assert.equal(resolveSecretType(config, 'billing'), 'private');
  assert.equal(resolveSecretType(config, 'defaults'), 'public');
});

test('init writes keysDir from project option', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'envcompile-init-'));
  const origCwd = process.cwd();
  process.chdir(tmpDir);
  try {
    const output = [];
    await main(['init', '--project', 'billing-api'], {
      stdin: { isTTY: false },
      stderrStream: { isTTY: false },
      out: (msg) => output.push(msg),
      err: () => {},
    });

    const content = await fs.readFile(path.join(tmpDir, 'envcompile.config.yaml'), 'utf8');
    assert.match(content, /keysDir: ~\/secrets\/billing-api/);
    assert.match(content, /environments:\n\s+- dev\n\s+- prod/);
    assert.doesNotMatch(content, /staging/);
    assert.match(content, /targets: \{\}/);
    assert.doesNotMatch(content, /stripe|cloudflare|defaults/);
    assert.ok(output.some((line) => line.includes('~/secrets/billing-api')));
    await fs.access(path.join(tmpDir, 'source_env_vars/dev'));
    await fs.access(path.join(tmpDir, 'source_env_vars/prod'));
    await assert.rejects(fs.access(path.join(tmpDir, 'source_env_vars/staging')), { code: 'ENOENT' });
    await fs.access(path.join(tmpDir, 'public_env_vars/dev'));
    await fs.access(path.join(tmpDir, 'public_env_vars/prod'));
    await assert.rejects(fs.access(path.join(tmpDir, 'public_env_vars/staging')), { code: 'ENOENT' });

    const sourcesOutput = [];
    await main(['sources'], { out: (msg) => sourcesOutput.push(msg), err: () => {} });
    assert.deepEqual(sourcesOutput, ['Private:', '  (none)', 'Public:', '  (none)']);
  } finally {
    process.chdir(origCwd);
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('init prompt defaults to current folder name', async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'envcompile-init-parent-'));
  const tmpDir = path.join(parent, 'folder-default');
  await fs.mkdir(tmpDir);
  const origCwd = process.cwd();
  process.chdir(tmpDir);
  try {
    await main(['init'], {
      promptText: async () => '',
      out: () => {},
      err: () => {},
    });

    const content = await fs.readFile(path.join(tmpDir, 'envcompile.config.yaml'), 'utf8');
    assert.match(content, /keysDir: ~\/secrets\/folder-default/);
  } finally {
    process.chdir(origCwd);
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test('env add updates YAML config and creates source directories', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'envcompile-env-'));
  const origCwd = process.cwd();
  process.chdir(tmpDir);
  try {
    await fs.writeFile(path.join(tmpDir, 'envcompile.config.yaml'), `version: 1

privateDir: source_env_vars
publicDir: public_env_vars
keysDir: keys

environments:
  - dev
  - prod

targets:
  api:
    output: compiled/{env}/.env.api
    sources:
      - app
`);

    const output = [];
    await main(['env', 'add', 'build'], { out: (msg) => output.push(msg), err: () => {} });
    await main(['env', 'add', 'build'], { out: (msg) => output.push(msg), err: () => {} });

    const content = await fs.readFile(path.join(tmpDir, 'envcompile.config.yaml'), 'utf8');
    assert.equal((content.match(/build/g) || []).length, 1);
    assert.ok(output.some((line) => line.includes('already exists')));

    await fs.access(path.join(tmpDir, 'source_env_vars/build'));
    await fs.access(path.join(tmpDir, 'public_env_vars/build'));
  } finally {
    process.chdir(origCwd);
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('env add rejects invalid names', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'envcompile-env-invalid-'));
  const origCwd = process.cwd();
  process.chdir(tmpDir);
  try {
    await writeJsonConfig(tmpDir, {
      version: 1,
      privateDir: 'source_env_vars',
      keysDir: 'keys',
      environments: ['dev'],
      targets: { api: { sources: ['app'], output: 'compiled/{env}/.env.api' } },
    });

    await assert.rejects(
      main(['env', 'add', '../build'], { out: () => {}, err: () => {} }),
      /Invalid environment name/,
    );
  } finally {
    process.chdir(origCwd);
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('targets commands update YAML config idempotently', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'envcompile-targets-'));
  const origCwd = process.cwd();
  process.chdir(tmpDir);
  try {
    await fs.writeFile(path.join(tmpDir, 'envcompile.config.yaml'), `version: 1

privateDir: source_env_vars
keysDir: keys

environments:
  - dev

targets: {}
`);

    const output = [];
    await main(['targets', 'add', 'api'], { out: (msg) => output.push(msg), err: () => {} });
    await main(['targets', 'add', 'api'], { out: (msg) => output.push(msg), err: () => {} });
    await main(['targets', 'add', 'web', '--output', 'compiled/{env}/.env.web', '--description', 'Web runtime'], {
      out: (msg) => output.push(msg),
      err: () => {},
    });

    const content = await fs.readFile(path.join(tmpDir, 'envcompile.config.yaml'), 'utf8');
    assert.match(content, /api:\n\s+output: compiled_env\/\{env\}\/\.env\.api\n\s+sources: \[\]/);
    assert.match(content, /web:\n\s+output: compiled\/\{env\}\/\.env\.web\n\s+sources: \[\]\n\s+description: Web runtime/);
    assert.ok(output.some((line) => line.includes('already exists')));

    const listOutput = [];
    await main(['targets', 'list'], { out: (msg) => listOutput.push(msg), err: () => {} });
    assert.ok(listOutput.includes('api'));
    assert.ok(listOutput.includes('web - Web runtime'));

    await main(['targets', 'remove', 'api'], { out: () => {}, err: () => {} });
    const removedContent = await fs.readFile(path.join(tmpDir, 'envcompile.config.yaml'), 'utf8');
    assert.doesNotMatch(removedContent, /api:/);
  } finally {
    process.chdir(origCwd);
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('pre-commit command installs git hook', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'envcompile-cli-'));
  const { execSync } = await import('node:child_process');
  execSync('git init', { cwd: tmpDir, stdio: 'pipe' });
  const origCwd = process.cwd();
  process.chdir(tmpDir);
  try {
    const output = [];
    await main(['pre-commit'], { out: (msg) => output.push(msg), err: () => {} });

    const hookPath = path.join(tmpDir, '.git', 'hooks', 'pre-commit');
    const content = await fs.readFile(hookPath, 'utf8');
    assert.ok(content.includes('envcompile pre-commit'));
    assert.ok(content.includes('encrypted:'));

    const stat = await fs.stat(hookPath);
    assert.ok(stat.mode & 0o111, 'hook should be executable');

    // Running again should be idempotent
    const output2 = [];
    await main(['pre-commit'], { out: (msg) => output2.push(msg), err: () => {} });
    assert.ok(output2[0].includes('already'));
  } finally {
    process.chdir(origCwd);
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('pre-commit hook detects unencrypted env files', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'envcompile-hook-'));
  const origCwd = process.cwd();
  process.chdir(tmpDir);
  try {
    // Set up a git repo with the hook
    const { execSync } = await import('node:child_process');
    execSync('git init', { cwd: tmpDir, stdio: 'pipe' });
    execSync('git config user.email "test@test.com"', { cwd: tmpDir, stdio: 'pipe' });
    execSync('git config user.name "Test"', { cwd: tmpDir, stdio: 'pipe' });

    await main(['pre-commit'], { out: () => {}, err: () => {} });

    // Stage an unencrypted .env file — commit should fail
    await fs.writeFile(path.join(tmpDir, '.env.api'), 'SECRET_KEY=plaintext\n');
    execSync('git add .env.api', { cwd: tmpDir, stdio: 'pipe' });

    let commitFailed = false;
    try {
      execSync('git commit -m "test"', { cwd: tmpDir, stdio: 'pipe' });
    } catch {
      commitFailed = true;
    }
    assert.ok(commitFailed, 'commit should fail for unencrypted .env file');

    // Now write an encrypted file — commit should succeed
    await fs.writeFile(path.join(tmpDir, '.env.api'), 'SECRET_KEY="encrypted:abc123"\n');
    execSync('git add .env.api', { cwd: tmpDir, stdio: 'pipe' });
    execSync('git commit -m "test encrypted"', { cwd: tmpDir, stdio: 'pipe' });

    // Example files should be allowed through unencrypted
    await fs.writeFile(path.join(tmpDir, '.env.example'), 'SECRET_KEY=changeme\n');
    execSync('git add .env.example', { cwd: tmpDir, stdio: 'pipe' });
    execSync('git commit -m "test example"', { cwd: tmpDir, stdio: 'pipe' });
  } finally {
    process.chdir(origCwd);
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('gitignore command adds key ignore entries to source directories', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'envcompile-cli-'));
  const origCwd = process.cwd();
  process.chdir(tmpDir);
  try {
    const sourceDir = path.join(tmpDir, 'source_env_vars');
    await fs.mkdir(path.join(sourceDir, 'dev'), { recursive: true });
    await fs.writeFile(path.join(tmpDir, 'envcompile.config.json'), JSON.stringify({
      version: 1,
      sourceDir: 'source_env_vars',
      keysDir: 'source_env_vars',
      environments: ['dev'],
      targets: { api: { sources: ['app'], output: 'compiled/{env}/.env.api' } },
    }));

    const output = [];
    await main(['gitignore'], { out: (msg) => output.push(msg), err: () => {} });

    // Should update .gitignore in sourceDir and env subdirectories with *.keys glob
    const content = await fs.readFile(path.join(sourceDir, '.gitignore'), 'utf8');
    assert.ok(content.includes('*.keys'));

    const devContent = await fs.readFile(path.join(sourceDir, 'dev', '.gitignore'), 'utf8');
    assert.ok(devContent.includes('*.keys'));

    // Should update .gitignore in target output directories with *.keys and compiled output files
    const targetContent = await fs.readFile(path.join(tmpDir, 'compiled', 'dev', '.gitignore'), 'utf8');
    assert.ok(targetContent.includes('*.keys'));
    assert.ok(targetContent.includes('.env.api'), 'should ignore compiled output file');

    // Should NOT create .gitignore in project root
    await assert.rejects(fs.readFile(path.join(tmpDir, '.gitignore'), 'utf8'), { code: 'ENOENT' });

    // Running again should be idempotent
    const output2 = [];
    await main(['gitignore'], { out: (msg) => output2.push(msg), err: () => {} });
    assert.ok(output2[0].includes('already'));
  } finally {
    process.chdir(origCwd);
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('sources commands update YAML config idempotently', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'envcompile-sources-'));
  const origCwd = process.cwd();
  process.chdir(tmpDir);
  try {
    await fs.writeFile(path.join(tmpDir, 'envcompile.config.yaml'), `version: 1

privateDir: source_env_vars
publicDir: public_env_vars
keysDir: keys

environments:
  - dev

targets:
  api:
    output: compiled/{env}/.env.api
    sources:
      - app
`);

    const output = [];
    await main(['sources', 'add', 'audit'], { out: (msg) => output.push(msg), err: () => {} });
    await main(['sources', 'add', 'audit'], { out: (msg) => output.push(msg), err: () => {} });
    await main(['sources', 'add', 'shared-defaults', '--public'], { out: (msg) => output.push(msg), err: () => {} });
    await main(['sources', 'add', 'billing', '--target', 'api'], { out: (msg) => output.push(msg), err: () => {} });
    await main(['sources', 'add', 'billing', '--target', 'api'], { out: (msg) => output.push(msg), err: () => {} });
    await main(['sources', 'add', 'defaults', '--target', 'api', '--public'], { out: (msg) => output.push(msg), err: () => {} });

    const content = await fs.readFile(path.join(tmpDir, 'envcompile.config.yaml'), 'utf8');
    assert.equal((content.match(/billing/g) || []).length, 1);
    assert.match(content, /^sources:\n\s+- audit/m);
    assert.match(content, /^publicSources:\n\s+- shared-defaults/m);
    assert.match(content, /publicSources:\n\s+- defaults/);
    assert.ok(output.some((line) => line.includes('already present')));
    assert.ok(output.some((line) => line.includes('already configured')));
    assert.ok(output.some((line) => line.includes('Created:')));
    assert.ok(output.some((line) => line.includes('Exists:')));
    assert.equal(await fs.readFile(path.join(tmpDir, 'source_env_vars/dev/.env.audit'), 'utf8'), '');
    assert.equal(await fs.readFile(path.join(tmpDir, 'source_env_vars/dev/.env.billing'), 'utf8'), '');
    assert.equal(await fs.readFile(path.join(tmpDir, 'public_env_vars/dev/.env.shared-defaults'), 'utf8'), '');
    assert.equal(await fs.readFile(path.join(tmpDir, 'public_env_vars/dev/.env.defaults'), 'utf8'), '');

    const listOutput = [];
    await main(['sources', 'list', '--target', 'api'], { out: (msg) => listOutput.push(msg), err: () => {} });
    assert.ok(listOutput.includes('Private:'));
    assert.ok(listOutput.some((line) => line.includes('billing (api)')));
    assert.ok(listOutput.some((line) => line.includes('defaults (api)')));

    const allOutput = [];
    await main(['sources', 'list'], { out: (msg) => allOutput.push(msg), err: () => {} });
    assert.ok(allOutput.some((line) => line.includes('billing (api)')));
    assert.ok(allOutput.some((line) => line.includes('audit (no targets)')));
    assert.ok(allOutput.some((line) => line.includes('shared-defaults (no targets)')));

    await main(['sources', 'remove', 'shared-defaults', '--public'], { out: () => {}, err: () => {} });
    await main(['sources', 'remove', 'defaults', '--target', 'api', '--public'], { out: () => {}, err: () => {} });
    const removedContent = await fs.readFile(path.join(tmpDir, 'envcompile.config.yaml'), 'utf8');
    assert.doesNotMatch(removedContent, /defaults/);

    await assert.rejects(
      main(['group', 'list'], { out: () => {}, err: () => {} }),
      /Unknown command "group"/,
    );
  } finally {
    process.chdir(origCwd);
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('private secret set provisions once, preserves keys, and creates backups', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'envcompile-secret-'));
  const origCwd = process.cwd();
  process.chdir(tmpDir);
  try {
    await writeJsonConfig(tmpDir, {
      version: 1,
      privateDir: 'source_env_vars',
      keysDir: 'keys',
      environments: ['dev'],
      targets: { api: { sources: ['stripe'], output: 'compiled/{env}/.env.api' } },
    });

    await main(
      ['secret', 'set', 'stripe', 'STRIPE_SECRET_KEY', '--env', 'dev', '--private', '--stdin'],
      { stdin: 'sk_dev\n', out: () => {}, err: () => {} },
    );

    const sourceFile = path.join(tmpDir, 'source_env_vars/dev/.env.stripe');
    const keyFile = path.join(tmpDir, 'keys/dev/.env.stripe.keys');
    const firstKeys = parsePrivateKeys(await fs.readFile(keyFile, 'utf8'));
    assert.ok(firstKeys.DOTENV_PRIVATE_KEY_STRIPE);

    await main(
      ['secret', 'set', 'stripe', 'STRIPE_PUBLISHABLE_KEY', '--env', 'dev', '--private', '--stdin'],
      { stdin: 'pk_dev\n', out: () => {}, err: () => {} },
    );

    const secondKeys = parsePrivateKeys(await fs.readFile(keyFile, 'utf8'));
    assert.deepEqual(secondKeys, firstKeys);

    const decrypted = await decryptFile({ filePath: sourceFile, envKeysFile: keyFile, noOps: true });
    const parsed = parseDotenv(decrypted);
    assert.equal(parsed.STRIPE_SECRET_KEY, 'sk_dev');
    assert.equal(parsed.STRIPE_PUBLISHABLE_KEY, 'pk_dev');

    await main(
      ['secret', 'unset', 'stripe', 'STRIPE_PUBLISHABLE_KEY', '--env', 'dev', '--private'],
      { out: () => {}, err: () => {} },
    );
    const afterUnsetKeys = parsePrivateKeys(await fs.readFile(keyFile, 'utf8'));
    assert.deepEqual(afterUnsetKeys, firstKeys);
    const decryptedAfterUnset = await decryptFile({ filePath: sourceFile, envKeysFile: keyFile, noOps: true });
    const parsedAfterUnset = parseDotenv(decryptedAfterUnset);
    assert.equal(parsedAfterUnset.STRIPE_SECRET_KEY, 'sk_dev');
    assert.equal(parsedAfterUnset.STRIPE_PUBLISHABLE_KEY, undefined);

    const backupRoot = path.join(tmpDir, 'keys/.envcompile-backups');
    const backupRuns = await fs.readdir(backupRoot);
    assert.equal(backupRuns.length, 2);
  } finally {
    process.chdir(origCwd);
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('public secret set writes plaintext without key files', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'envcompile-public-secret-'));
  const origCwd = process.cwd();
  process.chdir(tmpDir);
  try {
    await writeJsonConfig(tmpDir, {
      version: 1,
      privateDir: 'source_env_vars',
      publicDir: 'public_env_vars',
      keysDir: 'keys',
      environments: ['dev'],
      targets: {
        web: {
          sources: ['app'],
          publicSources: ['defaults'],
          output: 'compiled/{env}/.env.web',
        },
      },
    });

    await main(
      ['secret', 'set', 'defaults', 'LOG_LEVEL', '--env', 'dev', '--public', '--stdin'],
      { stdin: 'debug\n', out: () => {}, err: () => {} },
    );

    const publicFile = path.join(tmpDir, 'public_env_vars/dev/.env.defaults');
    assert.equal(await fs.readFile(publicFile, 'utf8'), 'LOG_LEVEL="debug"\n');
    await assert.rejects(fs.readFile(path.join(tmpDir, 'keys/dev/.env.defaults.keys'), 'utf8'), { code: 'ENOENT' });
  } finally {
    process.chdir(origCwd);
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('secret commands fail for ambiguous type, invalid inputs, and non-tty prompt', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'envcompile-secret-fail-'));
  const origCwd = process.cwd();
  process.chdir(tmpDir);
  try {
    await writeJsonConfig(tmpDir, {
      version: 1,
      privateDir: 'source_env_vars',
      publicDir: 'public_env_vars',
      keysDir: 'keys',
      environments: ['dev'],
      targets: {
        api: {
          sources: ['shared'],
          publicSources: ['shared'],
          output: 'compiled/{env}/.env.api',
        },
      },
    });

    await assert.rejects(
      main(['secret', 'set', 'shared', 'TOKEN', '--env', 'dev', '--stdin'], { stdin: 'value\n', out: () => {}, err: () => {} }),
      /both private and public/,
    );
    await assert.rejects(
      main(['sources', 'add', 'other', '--target', 'missing'], { out: () => {}, err: () => {} }),
      /Unknown target/,
    );
    await assert.rejects(
      main(['secret', 'set', 'shared', 'TOKEN', '--env', 'prod', '--private', '--stdin'], { stdin: 'value\n', out: () => {}, err: () => {} }),
      /Unknown environment/,
    );
    await assert.rejects(
      main(['secret', 'set', 'shared', '1BAD', '--env', 'dev', '--private', '--stdin'], { stdin: 'value\n', out: () => {}, err: () => {} }),
      /Invalid secret key/,
    );
    await assert.rejects(
      main(['secret', 'set', 'shared', 'TOKEN', '--env', 'dev', '--private'], {
        stdin: { isTTY: false },
        stderrStream: { isTTY: false },
        out: () => {},
        err: () => {},
      }),
      /requires --stdin/,
    );

    await writeJsonConfig(tmpDir, {
      version: 1,
      privateDir: 'source_env_vars',
      keysDir: 'keys',
      environments: ['dev'],
      targets: { api: { sources: ['app'], output: 'compiled/{env}/.env.api' } },
    });
    await assert.rejects(
      main(['secret', 'set', 'defaults', 'LOG_LEVEL', '--env', 'dev', '--public', '--stdin'], { stdin: 'debug\n', out: () => {}, err: () => {} }),
      /publicDir is not configured/,
    );
  } finally {
    process.chdir(origCwd);
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

async function writeJsonConfig(dir, config) {
  await fs.writeFile(path.join(dir, 'envcompile.config.json'), `${JSON.stringify(config, null, 2)}\n`);
}
