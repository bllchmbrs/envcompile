import test from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs } from '../src/cli.js';

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
