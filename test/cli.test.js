import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseArgs, main } from '../src/cli.js';

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

    // Should update .gitignore in sourceDir and env subdirectories with specific key files
    const content = await fs.readFile(path.join(sourceDir, '.gitignore'), 'utf8');
    assert.ok(content.includes('.env.keys'));
    assert.ok(content.includes('.env.app.keys'));
    assert.ok(!content.includes('*.env.keys'), 'should not use wildcard pattern');

    const devContent = await fs.readFile(path.join(sourceDir, 'dev', '.gitignore'), 'utf8');
    assert.ok(devContent.includes('.env.app.keys'));

    // Should update .gitignore in target output directories with wildcard pattern
    const targetContent = await fs.readFile(path.join(tmpDir, 'compiled', 'dev', '.gitignore'), 'utf8');
    assert.ok(targetContent.includes('*.env.keys'));

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
