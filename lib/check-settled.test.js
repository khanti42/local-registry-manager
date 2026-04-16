import assert from 'node:assert/strict';
import test from 'node:test';
import {
  extractDevBase,
  isDevPrerelease,
  filterStableVersions,
  getHigherStableVersions,
} from './check-settled.js';

// --- extractDevBase ---

test('extractDevBase strips prerelease from dev version', () => {
  assert.equal(extractDevBase('1.2.3-dev.5'), '1.2.3');
  assert.equal(extractDevBase('0.34.0-dev.1'), '0.34.0');
  assert.equal(extractDevBase('2.0.0-dev.12'), '2.0.0');
});

test('extractDevBase works on a plain stable version', () => {
  assert.equal(extractDevBase('1.2.3'), '1.2.3');
});

test('extractDevBase throws on invalid semver', () => {
  assert.throws(() => extractDevBase('not-a-version'), /Invalid semver/);
});

// --- isDevPrerelease ---

test('isDevPrerelease returns true for matching preid', () => {
  assert.equal(isDevPrerelease('1.2.3-dev.1', 'dev'), true);
  assert.equal(isDevPrerelease('0.34.0-dev.99', 'dev'), true);
});

test('isDevPrerelease returns false for different preid', () => {
  assert.equal(isDevPrerelease('1.2.3-rc.1', 'dev'), false);
  assert.equal(isDevPrerelease('1.2.3-alpha.1', 'dev'), false);
});

test('isDevPrerelease returns false for stable version', () => {
  assert.equal(isDevPrerelease('1.2.3', 'dev'), false);
});

test('isDevPrerelease returns false for invalid semver', () => {
  assert.equal(isDevPrerelease('not-a-version', 'dev'), false);
});

// --- filterStableVersions ---

test('filterStableVersions removes prereleases', () => {
  const versions = ['1.0.0', '1.1.0-dev.1', '1.1.0', '1.2.0-rc.1', '1.2.0'];
  assert.deepEqual(filterStableVersions(versions), ['1.0.0', '1.1.0', '1.2.0']);
});

test('filterStableVersions returns empty array when all are prereleases', () => {
  assert.deepEqual(filterStableVersions(['1.0.0-dev.1', '1.0.0-rc.2']), []);
});

test('filterStableVersions returns all when none are prereleases', () => {
  assert.deepEqual(filterStableVersions(['1.0.0', '1.1.0']), ['1.0.0', '1.1.0']);
});

// --- getHigherStableVersions ---

test('getHigherStableVersions returns stable versions strictly > devBase sorted ascending', () => {
  const versions = ['1.0.0', '1.1.5', '1.2.0-dev.3', '1.2.0', '1.3.0', '2.0.0'];
  assert.deepEqual(
    getHigherStableVersions(versions, '1.2.0'),
    ['1.3.0', '2.0.0'],
  );
});

test('getHigherStableVersions returns empty when only the base version is on npm', () => {
  const versions = ['1.0.0', '1.1.5', '1.2.0'];
  assert.deepEqual(getHigherStableVersions(versions, '1.2.0'), []);
});

test('getHigherStableVersions returns empty when nothing has shipped yet', () => {
  const versions = ['1.0.0', '1.1.5', '1.2.0-dev.3'];
  assert.deepEqual(getHigherStableVersions(versions, '1.2.0'), []);
});

test('getHigherStableVersions excludes versions strictly below devBase', () => {
  const versions = ['1.0.0', '1.1.0', '1.3.0'];
  assert.deepEqual(getHigherStableVersions(versions, '1.2.0'), ['1.3.0']);
});

test('getHigherStableVersions sorts correctly across major bumps', () => {
  const versions = ['2.0.0', '1.3.0', '1.2.1'];
  assert.deepEqual(
    getHigherStableVersions(versions, '1.2.0'),
    ['1.2.1', '1.3.0', '2.0.0'],
  );
});
