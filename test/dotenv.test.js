import { test, expect } from 'bun:test';
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

  expect(parsed).toEqual({
    SIMPLE: 'hello',
    QUOTED: 'hello world',
    SINGLE: 'literal value',
    INLINE: 'value',
    MULTILINE: 'a\nb',
  });
});

test('parsePrivateKeys returns dotenvx private key entries only', () => {
  expect(parsePrivateKeys(`
DOTENV_PUBLIC_KEY="public"
DOTENV_PRIVATE_KEY_API="private"
OTHER=value
`)).toEqual({
    DOTENV_PRIVATE_KEY_API: 'private',
  });
});

test('stringifyDotenv quotes values and skips public keys', () => {
  expect(
    stringifyDotenv([
      ['DOTENV_PUBLIC_KEY', 'public'],
      ['HELLO', 'hello world'],
      ['MULTI', 'a\nb'],
    ]),
  ).toBe('HELLO="hello world"\nMULTI="a\\nb"\n');
});

test('privateKeyExportName normalizes target and environment labels', () => {
  expect(privateKeyExportName('api-worker', 'prod')).toBe('DOTENV_PRIVATE_KEY_API_WORKER_PROD');
});
