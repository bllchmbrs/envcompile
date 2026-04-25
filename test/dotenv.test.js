import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDotenv, parsePrivateKeys, stringifyDotenv, privateKeyExportName } from '../src/dotenv.js';

test('parseDotenv handles comments, quotes, and export prefixes', () => {
  const parsed = parseDotenv(`
# comment
export SIMPLE=hello
QUOTED="hello world"
SINGLE='literal value'
INLINE=value # comment
MULTILINE="a\\nb"
`);

  assert.deepEqual(parsed, {
    SIMPLE: 'hello',
    QUOTED: 'hello world',
    SINGLE: 'literal value',
    INLINE: 'value',
    MULTILINE: 'a\nb',
  });
});

test('parsePrivateKeys returns dotenvx private key entries only', () => {
  assert.deepEqual(parsePrivateKeys(`
DOTENV_PUBLIC_KEY="public"
DOTENV_PRIVATE_KEY_API="private"
OTHER=value
`), {
    DOTENV_PRIVATE_KEY_API: 'private',
  });
});

test('stringifyDotenv quotes values and skips public keys', () => {
  assert.equal(
    stringifyDotenv([
      ['DOTENV_PUBLIC_KEY', 'public'],
      ['HELLO', 'hello world'],
      ['MULTI', 'a\nb'],
    ]),
    'HELLO="hello world"\nMULTI="a\\nb"\n',
  );
});

test('privateKeyExportName normalizes target and environment labels', () => {
  assert.equal(privateKeyExportName('api-worker', 'prod'), 'DOTENV_PRIVATE_KEY_API_WORKER_PROD');
});
