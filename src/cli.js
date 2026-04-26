import fs from 'node:fs/promises';
import path from 'node:path';
import { loadConfig } from './config.js';
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
  resolveSourceKeyFile,
  resolveTargetOutput,
  validateConfig,
} from './engine.js';
import { EnvcompileError, configError } from './errors.js';
import { parsePrivateKeys } from './dotenv.js';
import { toDisplayPath } from './paths.js';
import { spawnFile } from './process.js';

const HELP = `envcompile

Usage:
  envcompile init [--force]
  envcompile list [--config <path>]
  envcompile sources [--config <path>]
  envcompile targets [--config <path>]
  envcompile compile <target> --env <env> [--out <path>] [--dry-run] [--force] [--print-key] [--dotenvx <bin>]
  envcompile check [target] [--env <env>] [--dotenvx <bin>]
  envcompile lint [target] [--env <env>] [--strict] [--dotenvx <bin>]
  envcompile compare [target] [--env <a,b,c>] [--source <source>] [--dotenvx <bin>]
  envcompile validate [--config <path>]
  envcompile encrypt [source] [--env <env>] [--config <path>] [--dotenvx <bin>]
  envcompile decrypt [source] [--env <env>] [--config <path>] [--dotenvx <bin>]
  envcompile inspect <target> --env <env> [--show-values --yes] [--dotenvx <bin>]
  envcompile gitignore
  envcompile pre-commit [--force]

Global options:
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
      await sourcesCommand(options, io);
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
    if (['dryRun', 'force', 'printKey', 'showValues', 'strict', 'yes'].includes(name)) {
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

  const example = await fs.readFile(new URL('../envcompile.config.example.yaml', import.meta.url), 'utf8');
  await fs.writeFile(destination, example, { mode: 0o644 });
  await fs.mkdir(path.resolve(process.cwd(), 'source_env_vars/dev'), { recursive: true });
  await fs.mkdir(path.resolve(process.cwd(), 'source_env_vars/staging'), { recursive: true });
  await fs.mkdir(path.resolve(process.cwd(), 'source_env_vars/prod'), { recursive: true });
  io.out(`Created ${toDisplayPath(destination)}`);
}

async function listCommand(options, io) {
  const { config } = await loadConfig(process.cwd(), options.config);
  io.out(`Environments: ${config.environments.join(', ')}`);
  io.out(`Targets: ${Object.keys(config.targets).join(', ')}`);
}

async function sourcesCommand(options, io) {
  const { config } = await loadConfig(process.cwd(), options.config);
  const sources = new Set();
  for (const target of Object.values(config.targets)) {
    for (const source of target.sources) sources.add(source);
  }
  io.out([...sources].sort().join('\n'));
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

  const composed = await loadComposedTarget(config, targetName, options.env, {
    dotenvxBin: options.dotenvx,
  });

  if (options.showValues) {
    for (const [key, value] of composed.entries) io.out(`${key}=${value}`);
  } else {
    for (const [key] of composed.entries) io.out(key);
  }
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
  '*.env.keys',
  '.env.keys',
];

function buildSourceGitignoreLines(sources) {
  const lines = ['# envcompile: ignore private keys'];
  lines.push('.env.keys');
  for (const source of [...sources].sort()) {
    lines.push(`.env.${source}.keys`);
  }
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

  // Update .gitignore in target output directories with *.env.keys
  const targetDirs = new Set();
  for (const [targetName] of Object.entries(config.targets)) {
    for (const env of config.environments) {
      const outputFile = resolveTargetOutput(config, targetName, env);
      targetDirs.add(path.dirname(outputFile));
    }
  }

  for (const dir of targetDirs) {
    await fs.mkdir(dir, { recursive: true });
    if (await updateGitignore(dir, TARGET_GITIGNORE_LINES)) {
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
    out(message) {
      console.log(message);
    },
    err(message) {
      console.error(message);
    },
  };
}
