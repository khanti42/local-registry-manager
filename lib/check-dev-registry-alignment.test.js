import assert from 'node:assert/strict';
import test from 'node:test';
import { latestPreidPrereleaseOnReleaseLine } from './check-dev-registry-alignment.js';

test('returns max -dev.N on same X.Y.Z line', () => {
  const versions = [
    '5.0.1',
    '5.0.2',
    '5.0.2-dev.1',
    '5.0.2-dev.33',
    '5.0.2-dev.2',
    '5.0.3-dev.1',
  ];
  assert.equal(
    latestPreidPrereleaseOnReleaseLine(versions, '5.0.2-dev.2', 'dev'),
    '5.0.2-dev.33',
  );
});

test('returns null when declared is not a dev prerelease', () => {
  assert.equal(
    latestPreidPrereleaseOnReleaseLine(['1.0.0', '1.0.1'], '1.0.0', 'dev'),
    null,
  );
});

test('returns null when no matching prereleases on registry', () => {
  assert.equal(
    latestPreidPrereleaseOnReleaseLine(['1.0.0'], '2.0.0-dev.1', 'dev'),
    null,
  );
});
