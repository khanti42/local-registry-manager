import assert from 'node:assert/strict';
import test from 'node:test';
import { isNpmPublish409Error } from './is-npm-publish-409.js';

test('detects E409 from npm CLI', () => {
  assert.equal(
    isNpmPublish409Error('npm error code E409\n', ''),
    true,
  );
});

test('detects 409 Conflict line', () => {
  assert.equal(
    isNpmPublish409Error(
      'npm error 409 Conflict - PUT http://localhost:4873/@scope%2fpkg\n',
      '',
    ),
    true,
  );
});

test('detects Verdaccio already present message', () => {
  assert.equal(
    isNpmPublish409Error(
      'this package is already present',
      '',
    ),
    true,
  );
});

test('returns false for unrelated errors', () => {
  assert.equal(isNpmPublish409Error('npm ERR! 404 Not found', ''), false);
});
