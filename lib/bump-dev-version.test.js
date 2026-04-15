import assert from 'node:assert/strict';
import test from 'node:test';
import { bumpDevVersion, setFixedDevPrerelease } from './bump-dev-version.js';

test('appends -<preid>.1 from release version', () => {
  assert.equal(bumpDevVersion('1.2.3', 'dev'), '1.2.3-dev.1');
});

test('increments prerelease segment for matching preid', () => {
  assert.equal(bumpDevVersion('1.2.3-dev.1', 'dev'), '1.2.3-dev.2');
  assert.equal(bumpDevVersion('0.34.0-dev.9', 'dev'), '0.34.0-dev.10');
});

test('restarts prerelease when preid changes', () => {
  assert.equal(bumpDevVersion('1.0.0-rc.1', 'dev'), '1.0.0-dev.1');
});

test('setFixedDevPrerelease always yields -<preid>.1 from release base', () => {
  assert.equal(setFixedDevPrerelease('1.2.3', 'dev'), '1.2.3-dev.1');
  assert.equal(setFixedDevPrerelease('1.2.3-dev.1', 'dev'), '1.2.3-dev.1');
  assert.equal(setFixedDevPrerelease('1.2.3-dev.99', 'dev'), '1.2.3-dev.1');
  assert.equal(setFixedDevPrerelease('0.34.0-rc.2', 'dev'), '0.34.0-dev.1');
});
