import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline/promises';
import { loadConfig } from './config.js';
import { listConfiguredSources, updateEnvironment, updateSourceMembership } from './config-admin.js';
import {
  checkTargets,
  compareTarget,
  compileTarget,
  encryptSources,
  decryptSources,
  getTarget,
  lintTargets,
  loadComposedTarget,
  resolveSourceFile,
  resolvePublicSourceFile,
  resolveSourceKeyFile,
  resolveTargetOutput,
  validateConfig,
} from './engine.js';
import { EnvcompileError, configError } from './errors.js';
import { toDisplayPath } from './paths.js';
import { spawnFile } from './process.js';
import { setSecret, unsetSecret } from './secret-admin.js';

const HELP = `envcompile

Usage:
  envcompile init [--force] [--project <name>]
  envcompile list [--config <path>]
  envcompile targets [--config <path>]
  envcompile compile <target> --env <env> [--out <path>] [--dry-run] [--force] [--print-key] [--dotenvx <bin>]
  envcompile check [target] [--env <env>] [--dotenvx <bin>]
  envcompile lint [target] [--env <env>] [--strict] [--dotenvx <bin>]
  envcompile compare [target] [--env <a,b,c>] [--source <source>] [--dotenvx <bin>]
  envcompile validate [--config <path>]
  envcompile encrypt [source] [--env <env>] [--config <path>] [--dotenvx <bin>]
  envcompile decrypt [source] [--env <env>] [--config <path>] [--dotenvx <bin>]
  envcompile inspect <target> --env <env> [--show-values --yes] [--dotenvx <bin>]
  envcompile sources [list] [--target <target>] [--config <path>]
  envcompile sources add <name> --target <target> [--public] [--config <path>]
  envcompile sources remove <name> --target <target> [--public] [--config <path>]
  envcompile env add <name> [--config <path>]
  envcompile secret set <source> <KEY> --env <env> [--public|--private] [--stdin] [--config <path>] [--dotenvx <bin>]
  envcompile secret unset <source> <KEY> --env <env> [--public|--private] [--config <path>] [--dotenvx <bin>]
  envcompile gitignore
  envcompile pre-commit [--force]

Global options:
  --project <name>     Project name for init keysDir. Defaults to the current folder name.
  --config <path>       Config file path. Defaults to envcompile.config.{yaml,yml,json}.
  --dotenvx <bin>       dotenvx executable override. Defaults to bundled @dotenvx/dotenvx.
  -h, --help            Show help.
`;

export async function main(argv, io = defaultIo()) {
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    io.out(HELP.trimEnd());
    return;
  }

  const { command, positional, options } = parseArgs(argv);

  switch (command) {
    case 'init':
      await initCommand(options, io);
      break;
    case 'list':
      await listCommand(options, io);
      break;
    case 'sources':
      await sourcesCommand(positional, options, io);
      break;
    case 'targets':
      await targetsCommand(options, io);
      break;
    case 'compile':
      await compileCommand(positional, options, io);
      break;
    case 'check':
      await checkCommand(positional, options, io);
      break;
    case 'lint':
      await lintCommand(positional, options, io);
      break;
    case 'compare':
      await compareCommand(positional, options, io);
      break;
    case 'validate':
      await validateCommand(options, io);
      break;
    case 'encrypt':
      await encryptCommand(positional, options, io);
      break;
    case 'decrypt':
      await decryptCommand(positional, options, io);
      break;
    case 'inspect':
      await inspectCommand(positional, options, io);
      break;
    case 'env':
      await envCommand(positional, options, io);
      break;
    case 'secret':
      await secretCommand(positional, options, io);
      break;
    case 'gitignore':
      await gitignoreCommand(options, io);
      break;
    case 'pre-commit':
      await preCommitCommand(options, io);
      break;
    default:
      throw configError(`Unknown command "${command}". Run envcompile --help.`);
  }
}

export function parseArgs(argv) {
  const [command, ...rest] = argv;
  const positional = [];
  const options = {};

  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }

    const [rawName, inlineValue] = token.slice(2).split(/=(.*)/s, 2);
    const name = rawName.replace(/-([a-z])/g, (_, char) => char.toUpperCase());
    if (['dryRun', 'force', 'printKey', 'private', 'public', 'showValues', 'stdin', 'strict', 'yes'].includes(name)) {
      options[name] = true;
      continue;
    }

    const value = inlineValue ?? rest[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw configError(`Missing value for --${rawName}.`);
    }
    options[name] = value;
    if (inlineValue === undefined) index += 1;
  }

  return { command, positional, options };
}

async function initCommand(options, io) {
  const destination = path.resolve(process.cwd(), 'envcompile.config.yaml');
  if (!options.force) {
    try {
      await fs.access(destination);
      throw new EnvcompileError(`${destination} already exists. Use --force to overwrite.`, 1);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }

  const projectName = await resolveInitProjectName(options, io);
  await fs.writeFile(destination, buildInitConfig(projectName), { mode: 0o644 });
  await fs.mkdir(path.resolve(process.cwd(), 'source_env_vars/dev'), { recursive: true });
  await fs.mkdir(path.resolve(process.cwd(), 'source_env_vars/staging'), { recursive: true });
  await fs.mkdir(path.resolve(process.cwd(), 'source_env_vars/prod'), { recursive: true });
  await fs.mkdir(path.resolve(process.cwd(), 'public_env_vars/dev'), { recursive: true });
  await fs.mkdir(path.resolve(process.cwd(), 'public_env_vars/staging'), { recursive: true });
  await fs.mkdir(path.resolve(process.cwd(), 'public_env_vars/prod'), { recursive: true });
  io.out(`Created ${toDisplayPath(destination)}`);
  io.out(`Private keys: ~/secrets/${projectName}`);
}

function buildInitConfig(projectName) {
  return `version: 1

privateDir: source_env_vars
publicDir: public_env_vars
keysDir: ~/secrets/${projectName}

environments:
  - dev
  - staging
  - prod

keyFilePatterns:
  source: '{env}/.env.{source}.keys'

targets: {}
`;
}

async function resolveInitProjectName(options, io) {
  const defaultName = defaultProjectName(path.basename(process.cwd()));
  if (options.project) return validateProjectName(options.project);
  if (typeof io.promptText === 'function') {
    const answer = await io.promptText(`Project name (${defaultName}): `);
    return validateProjectName(String(answer || '').trim() || defaultName);
  }

  const input = streamOrDefault(io.stdin, process.stdin);
  const output = io.stderrStream || process.stderr;
  if (!input.isTTY || !output.isTTY) return defaultName;

  const rl = readline.createInterface({ input, output, terminal: true });
  try {
    const answer = await rl.question(`Project name (${defaultName}): `);
    return validateProjectName(String(answer || '').trim() || defaultName);
  } finally {
    rl.close();
  }
}

function defaultProjectName(folderName) {
  const sanitized = String(folderName || '')
    .trim()
    .replace(/[^A-Za-z0-9_.-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return sanitized || 'envcompile';
}

function validateProjectName(name) {
  const projectName = String(name || '').trim();
  if (
    !projectName
    || projectName === '.'
    || projectName === '..'
    || projectName.includes('..')
    || /[\\/]/.test(projectName)
    || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(projectName)
  ) {
    throw configError(`Invalid project name "${name}". Use letters, numbers, dots, dashes, or underscores.`);
  }
  return projectName;
}

async function listCommand(options, io) {
  const { config } = await loadConfig(process.cwd(), options.config);
  io.out(`Environments: ${config.environments.join(', ')}`);
  io.out(`Targets: ${Object.keys(config.targets).join(', ')}`);
}

async function sourcesCommand(positional, options, io) {
  const subcommand = positional[0] || 'list';
  if (subcommand === 'list') {
    const sources = await listConfiguredSources(process.cwd(), options.config, options.target);
    renderSourceList(sources, io);
    return;
  }

  if (!['add', 'remove'].includes(subcommand)) {
    throw configError(`Unknown sources command "${subcommand}". Run envcompile --help.`);
  }
  const sourceName = positional[1];
  if (!sourceName) throw configError(`sources ${subcommand} requires a source name.`);
  if (!options.target) throw configError(`sources ${subcommand} requires --target <target>.`);

  const result = await updateSourceMembership(process.cwd(), options.config, {
    action: subcommand,
    sourceName,
    targetName: options.target,
    publicSource: Boolean(options.public),
  });

  if (result.changed) {
    const verb = subcommand === 'add' ? 'Added' : 'Removed';
    io.out(`${verb} ${result.type} source ${result.sourceName} ${subcommand === 'add' ? 'to' : 'from'} ${result.targetName}`);
  } else {
    const state = subcommand === 'add' ? 'already present in' : 'not present in';
    io.out(`${result.type} source ${result.sourceName} is ${state} ${result.targetName}`);
  }
  io.out(`Config: ${toDisplayPath(result.configPath)}`);
}

async function targetsCommand(options, io) {
  const { config } = await loadConfig(process.cwd(), options.config);
  for (const [name, target] of Object.entries(config.targets)) {
    const suffix = target.description ? ` - ${target.description}` : '';
    io.out(`${name}${suffix}`);
  }
}

async function compileCommand(positional, options, io) {
  const targetName = positional[0];
  if (!targetName) throw configError('compile requires a target.');
  if (!options.env) throw configError('compile requires --env <env>.');

  const { config } = await loadConfig(process.cwd(), options.config);
  const result = await compileTarget(config, targetName, options.env, {
    dotenvxBin: options.dotenvx,
    dryRun: Boolean(options.dryRun),
    force: Boolean(options.force),
    out: options.out,
  });

  if (result.dryRun) {
    io.out(`Dry run ok: ${targetName}/${options.env}`);
    io.out(`Would write ${toDisplayPath(result.outputFile)}`);
    io.out(`Would write ${toDisplayPath(result.keyFile)}`);
    return;
  }

  io.out(`Compiled ${targetName}/${options.env}`);
  io.out(`Env:  ${toDisplayPath(result.outputFile)}`);
  io.out(`Keys: ${toDisplayPath(result.keyFile)}`);

  if (options.printKey) {
    for (const [key, value] of Object.entries(result.privateKeys || {})) {
      io.out(`${key}=${value}`);
    }
  }
}

async function checkCommand(positional, options, io) {
  const { config } = await loadConfig(process.cwd(), options.config);
  const targetName = positional[0];
  const results = await checkTargets(config, {
    targetName,
    env: options.env,
    dotenvxBin: options.dotenvx,
  });

  let ok = true;
  for (const result of results) {
    if (result.ok) {
      io.out(`ok ${result.targetName}/${result.env}`);
      continue;
    }
    ok = false;
    io.err(`fail ${result.targetName}/${result.env}`);
    for (const item of result.diagnostics) {
      io.err(`  ${formatDiagnosticLine(item)}`);
    }
  }

  if (!ok) throw new EnvcompileError('check failed', 1);
}

async function lintCommand(positional, options, io) {
  const { config } = await loadConfig(process.cwd(), options.config);
  const targetName = positional[0];
  const results = await lintTargets(config, {
    targetName,
    env: options.env,
    dotenvxBin: options.dotenvx,
    strict: Boolean(options.strict),
  });

  let ok = true;
  for (const result of results) {
    if (result.diagnostics.length === 0) {
      io.out(`ok ${result.targetName}/${result.env}`);
      continue;
    }

    if (!result.ok) ok = false;
    const prefix = result.ok ? 'warn' : 'fail';
    io.err(`${prefix} ${result.targetName}/${result.env}`);
    for (const item of result.diagnostics) {
      io.err(`  ${formatLintDiagnosticLine(item, result.duplicatePolicy)}`);
    }
  }

  if (!ok) throw new EnvcompileError('lint failed', 1);
}

async function compareCommand(positional, options, io) {
  const { config } = await loadConfig(process.cwd(), options.config);
  const targetName = positional[0];
  if (!targetName && !options.source) {
    throw configError('compare requires a target, or --source <source>.');
  }
  if (targetName) getTarget(config, targetName);

  const envs = options.env ? options.env.split(',').map((env) => env.trim()).filter(Boolean) : undefined;
  const comparison = await compareTarget(config, targetName, {
    source: options.source,
    envs,
    dotenvxBin: options.dotenvx,
  });

  renderComparison(comparison, io);
}

async function validateCommand(options, io) {
  const { config } = await loadConfig(process.cwd(), options.config);
  const results = await validateConfig(config);

  let ok = true;
  for (const result of results) {
    if (result.ok) {
      io.out(`ok ${result.label}`);
    } else {
      ok = false;
      io.err(`fail ${result.label}`);
      for (const message of result.errors) {
        io.err(`  ${message}`);
      }
    }
  }

  if (!ok) throw new EnvcompileError('validate failed', 1);
  io.out('Config is valid.');
}

async function encryptCommand(positional, options, io) {
  const { config } = await loadConfig(process.cwd(), options.config);
  const results = await encryptSources(config, {
    source: positional[0],
    env: options.env,
    dotenvxBin: options.dotenvx,
  });

  for (const result of results) {
    if (result.skipped) {
      io.out(`skip ${result.env}/${result.source} (already encrypted)`);
    } else {
      io.out(`encrypted ${result.env}/${result.source}`);
    }
  }
}

async function decryptCommand(positional, options, io) {
  const { config } = await loadConfig(process.cwd(), options.config);
  const results = await decryptSources(config, {
    source: positional[0],
    env: options.env,
    dotenvxBin: options.dotenvx,
  });

  for (const result of results) {
    if (result.skipped) {
      io.out(`skip ${result.env}/${result.source} (already decrypted)`);
    } else {
      io.out(`decrypted ${result.env}/${result.source}`);
    }
  }
}

async function inspectCommand(positional, options, io) {
  const targetName = positional[0];
  if (!targetName) throw configError('inspect requires a target.');
  if (!options.env) throw configError('inspect requires --env <env>.');
  if (options.showValues && !options.yes) {
    throw new EnvcompileError('inspect --show-values requires --yes.', 1);
  }

  const { config } = await loadConfig(process.cwd(), options.config);
  const target = getTarget(config, targetName);
  io.out(`${targetName}/${options.env}`);
  io.out(`Sources: ${target.sources.join(', ')}`);

  for (const source of target.sources) {
    io.out(`Source: ${toDisplayPath(resolveSourceFile(config, options.env, source))}`);
    io.out(`Keys:   ${toDisplayPath(resolveSourceKeyFile(config, options.env, source))}`);
  }

  if (target.publicSources.length > 0) {
    io.out(`Public sources: ${target.publicSources.join(', ')}`);
    for (const source of target.publicSources) {
      io.out(`Source: ${toDisplayPath(resolvePublicSourceFile(config, options.env, source))}`);
    }
  }

  const composed = await loadComposedTarget(config, targetName, options.env, {
    dotenvxBin: options.dotenvx,
  });

  if (options.showValues) {
    for (const [key, value] of composed.entries) io.out(`${key}=${value}`);
  } else {
    for (const [key] of composed.entries) io.out(key);
  }
}

async function envCommand(positional, options, io) {
  const subcommand = positional[0];
  if (subcommand !== 'add') {
    throw configError(`Unknown env command "${subcommand || ''}". Run envcompile --help.`);
  }
  const envName = positional[1];
  if (!envName) throw configError('env add requires an environment name.');

  const result = await updateEnvironment(process.cwd(), options.config, {
    action: 'add',
    envName,
  });

  await fs.mkdir(result.sourceDir, { recursive: true });
  if (result.publicDir) await fs.mkdir(result.publicDir, { recursive: true });

  if (result.changed) {
    io.out(`Added environment ${result.envName}`);
  } else {
    io.out(`Environment ${result.envName} already exists`);
  }
  io.out(`Private sources: ${toDisplayPath(result.sourceDir)}`);
  if (result.publicDir) io.out(`Public sources:  ${toDisplayPath(result.publicDir)}`);
  io.out(`Config: ${toDisplayPath(result.configPath)}`);
}

async function secretCommand(positional, options, io) {
  const subcommand = positional[0];
  if (!['set', 'unset'].includes(subcommand)) {
    throw configError(`Unknown secret command "${subcommand || ''}". Run envcompile --help.`);
  }
  const sourceName = positional[1];
  const key = positional[2];
  if (!sourceName) throw configError(`secret ${subcommand} requires a source name.`);
  if (!key) throw configError(`secret ${subcommand} requires a KEY.`);
  if (!options.env) throw configError(`secret ${subcommand} requires --env <env>.`);
  if (positional.length > 3) {
    if (subcommand === 'set') {
      throw configError('secret set reads values from prompt or --stdin; do not pass secret values as arguments.');
    }
    throw configError(`secret unset received unexpected argument "${positional[3]}".`);
  }

  if (subcommand === 'set') {
    const value = await readSecretValue(options, io);
    const result = await setSecret(process.cwd(), options.config, {
      sourceName,
      key,
      env: options.env,
      value,
      publicSource: Boolean(options.public),
      privateSource: Boolean(options.private),
      dotenvxBin: options.dotenvx,
    });
    renderSecretResult('Set', sourceName, key, options.env, result, io);
    return;
  }

  const result = await unsetSecret(process.cwd(), options.config, {
    sourceName,
    key,
    env: options.env,
    publicSource: Boolean(options.public),
    privateSource: Boolean(options.private),
    dotenvxBin: options.dotenvx,
  });
  renderSecretResult('Unset', sourceName, key, options.env, result, io);
}

function renderSourceList(sources, io) {
  renderSourceSection('Private', sources.privateSources, io);
  renderSourceSection('Public', sources.publicSources, io);
}

function renderSourceSection(label, sources, io) {
  io.out(`${label}:`);
  if (sources.length === 0) {
    io.out('  (none)');
    return;
  }
  for (const source of sources) {
    io.out(`  ${source.name} (${source.targets.join(', ')})`);
  }
}

function renderSecretResult(verb, sourceName, key, env, result, io) {
  io.out(`${verb} ${result.type} secret ${key} in ${env}/${sourceName}`);
  io.out(`Source: ${toDisplayPath(result.filePath)}`);
  if (result.keyFile) io.out(`Keys:   ${toDisplayPath(result.keyFile)}`);
  if (result.backupDir) io.out(`Backup: ${toDisplayPath(result.backupDir)}`);
}

async function readSecretValue(options, io) {
  if (options.stdin) {
    return chompOneTrailingNewline(await readAllStdin(io));
  }
  if (typeof io.promptSecret === 'function') {
    return io.promptSecret('Secret value: ');
  }

  const input = streamOrDefault(io.stdin, process.stdin);
  const output = io.stderrStream || process.stderr;
  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== 'function') {
    throw new EnvcompileError('secret set requires --stdin when input is not a TTY.', 1);
  }
  return promptHidden(input, output, 'Secret value: ');
}

async function readAllStdin(io) {
  if (typeof io.stdin === 'string') return io.stdin;
  const input = streamOrDefault(io.stdin, process.stdin);
  const chunks = [];
  for await (const chunk of input) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function streamOrDefault(candidate, fallback) {
  return candidate && typeof candidate !== 'string' ? candidate : fallback;
}

function chompOneTrailingNewline(value) {
  return String(value).replace(/\r?\n$/, '');
}

function promptHidden(input, output, prompt) {
  return new Promise((resolve, reject) => {
    let value = '';
    const cleanup = () => {
      input.off('data', onData);
      input.setRawMode(false);
      input.pause();
      output.write('\n');
    };
    const finish = () => {
      cleanup();
      resolve(value);
    };
    const onData = (chunk) => {
      const bytes = Buffer.from(chunk);
      for (const byte of bytes) {
        if (byte === 3) {
          cleanup();
          reject(new EnvcompileError('secret input cancelled.', 1));
          return;
        }
        if (byte === 13 || byte === 10) {
          finish();
          return;
        }
        if (byte === 127 || byte === 8) {
          value = value.slice(0, -1);
          continue;
        }
        value += Buffer.from([byte]).toString('utf8');
      }
    };

    output.write(prompt);
    input.setRawMode(true);
    input.resume();
    input.on('data', onData);
  });
}

function renderComparison(comparison, io) {
  const header = ['Key', ...comparison.envs];
  const rows = comparison.keys.map((key) => {
    const cells = [key];
    for (const snapshot of comparison.snapshots) {
      const found = snapshot.composed.entries.some(([entryKey]) => entryKey === key);
      cells.push(found ? 'present' : 'missing');
    }
    return cells;
  });

  const widths = header.map((cell, index) => {
    return Math.max(cell.length, ...rows.map((row) => row[index].length));
  });

  io.out(formatRow(header, widths));
  io.out(formatRow(widths.map((width) => '-'.repeat(width)), widths));
  for (const row of rows) io.out(formatRow(row, widths));
}

function formatRow(row, widths) {
  return row.map((cell, index) => cell.padEnd(widths[index])).join('  ');
}

function formatDiagnosticLine(item) {
  if (item.type === 'duplicate') {
    return `duplicate ${item.key}: ${item.firstSource} and ${item.secondSource}`;
  }
  if (item.type === 'missing-required') {
    return `missing required ${item.key}`;
  }
  return item.message || String(item.type);
}

function formatLintDiagnosticLine(item, duplicatePolicy) {
  if (item.type === 'duplicate') {
    const hierarchy = formatDuplicateHierarchy(item, duplicatePolicy);
    return `duplicate ${item.key}: ${item.firstSource} and ${item.secondSource}${hierarchy}`;
  }
  return item.message || String(item.type);
}

function formatDuplicateHierarchy(item, duplicatePolicy) {
  if (duplicatePolicy === 'first-wins') {
    return `; ${item.firstSource} wins because it appears earlier in target.sources`;
  }
  if (duplicatePolicy === 'last-wins') {
    return `; ${item.secondSource} wins because it appears later in target.sources`;
  }
  if (duplicatePolicy === 'error') {
    return '; compilation fails unless duplicatePolicy allows duplicates';
  }
  return '';
}

const PRE_COMMIT_HOOK = `#!/usr/bin/env bash
# envcompile pre-commit hook: block unencrypted .env files from being committed
# Installed by: envcompile pre-commit

ENCRYPTED_PATTERN='^[A-Za-z_][A-Za-z0-9_]*[[:space:]]*=[[:space:]]*"?encrypted:'

failed=0
for file in $(git diff --cached --name-only --diff-filter=ACM); do
  case "$file" in
    *.env.keys|*.env.keys.*) continue ;;
    *.env.example|*.env.example.*|.env.example) continue ;;
    *.env|*.env.*|.env)
      content=$(git show ":$file")
      if [ -n "$content" ] && ! echo "$content" | grep -qE "$ENCRYPTED_PATTERN"; then
        echo "ERROR: Unencrypted env file staged for commit: $file"
        echo "       Run 'envcompile encrypt' before committing."
        failed=1
      fi
      ;;
  esac
done

if [ "$failed" -eq 1 ]; then
  exit 1
fi
`;

const HOOK_MARKER = '# Installed by: envcompile pre-commit';

async function preCommitCommand(options, io) {
  const { code, stdout } = await spawnFile('git', ['rev-parse', '--git-common-dir']);
  if (code !== 0) {
    throw new EnvcompileError('Not a git repository. Run this from a git repo root.', 1);
  }
  const hooksDir = path.join(path.resolve(process.cwd(), stdout.trim()), 'hooks');
  await fs.mkdir(hooksDir, { recursive: true });
  const hookPath = path.join(hooksDir, 'pre-commit');

  try {
    const existing = await fs.readFile(hookPath, 'utf8');
    if (existing.includes(HOOK_MARKER)) {
      io.out('Pre-commit hook already installed.');
      return;
    }
    if (!options.force) {
      throw new EnvcompileError(
        `A pre-commit hook already exists at ${hookPath}. Use --force to overwrite.`,
        1,
      );
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  await fs.writeFile(hookPath, PRE_COMMIT_HOOK, { mode: 0o755 });
  io.out(`Installed pre-commit hook at ${toDisplayPath(hookPath)}`);
}

const TARGET_GITIGNORE_LINES = [
  '# envcompile: ignore private keys',
  '*.keys',
];

function buildSourceGitignoreLines(sources) {
  const lines = ['# envcompile: ignore private keys'];
  lines.push('*.keys');
  return lines;
}

async function updateGitignore(dirPath, lines) {
  const gitignorePath = path.join(dirPath, '.gitignore');
  let existing = '';
  try {
    existing = await fs.readFile(gitignorePath, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const existingLines = existing.split('\n');
  const toAdd = lines.filter((line) => !existingLines.includes(line));

  if (toAdd.length === 0) return false;

  const suffix = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
  const prefix = existing.length > 0 ? '\n' : '';
  await fs.writeFile(gitignorePath, existing + suffix + prefix + toAdd.join('\n') + '\n');
  return true;
}

async function gitignoreCommand(options, io) {
  const { config } = await loadConfig(process.cwd(), options.config);
  const sourceDir = config.sourceDir;

  // Collect all source names from all targets
  const allSources = new Set();
  for (const target of Object.values(config.targets)) {
    for (const source of target.sources) allSources.add(source);
  }

  const sourceGitignoreLines = buildSourceGitignoreLines(allSources);

  // Update .gitignore in sourceDir and each environment subdirectory
  const sourceDirs = [sourceDir];
  for (const env of config.environments) {
    sourceDirs.push(path.join(sourceDir, env));
  }

  let updated = 0;
  for (const dir of sourceDirs) {
    try {
      await fs.access(dir);
    } catch {
      continue;
    }
    if (await updateGitignore(dir, sourceGitignoreLines)) {
      io.out(`Updated ${toDisplayPath(path.join(dir, '.gitignore'))}`);
      updated++;
    }
  }

  // Update .gitignore in target output directories with *.keys and compiled output files
  const targetOutputsByDir = new Map();
  for (const [targetName] of Object.entries(config.targets)) {
    for (const env of config.environments) {
      const outputFile = resolveTargetOutput(config, targetName, env);
      const dir = path.dirname(outputFile);
      if (!targetOutputsByDir.has(dir)) targetOutputsByDir.set(dir, []);
      targetOutputsByDir.get(dir).push(path.basename(outputFile));
    }
  }

  for (const [dir, outputFiles] of targetOutputsByDir) {
    const lines = [
      ...TARGET_GITIGNORE_LINES,
      '# envcompile: ignore compiled output',
      ...([...new Set(outputFiles)].sort()),
    ];
    await fs.mkdir(dir, { recursive: true });
    if (await updateGitignore(dir, lines)) {
      io.out(`Updated ${toDisplayPath(path.join(dir, '.gitignore'))}`);
      updated++;
    }
  }

  if (updated === 0) {
    io.out('.gitignore already has envcompile entries in all source and target directories.');
  }
}

function defaultIo() {
  return {
    stdin: process.stdin,
    stderrStream: process.stderr,
    out(message) {
      console.log(message);
    },
    err(message) {
      console.error(message);
    },
  };
}
