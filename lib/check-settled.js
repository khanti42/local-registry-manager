import semver from 'semver';

/**
 * Extract the stable base from a dev prerelease version string.
 * '1.2.3-dev.5' -> '1.2.3'
 * Throws if the version is not a valid semver prerelease.
 *
 * @param {string} version
 * @returns {string}
 */
export function extractDevBase(version) {
  const v = semver.parse(version);
  if (!v) {
    throw new Error(`Invalid semver version: ${version}`);
  }
  return `${v.major}.${v.minor}.${v.patch}`;
}

/**
 * Whether a version string is a dev prerelease with the given preid.
 * e.g. isDevPrerelease('1.2.3-dev.5', 'dev') -> true
 *
 * @param {string} version
 * @param {string} preid
 * @returns {boolean}
 */
export function isDevPrerelease(version, preid) {
  const v = semver.parse(version);
  if (!v) return false;
  const pr = v.prerelease;
  return (
    pr.length >= 2 &&
    pr[0] === preid &&
    typeof pr[1] === 'number' &&
    Number.isFinite(pr[1])
  );
}

/**
 * Filter an array of version strings to stable releases only (no prerelease tag).
 *
 * @param {string[]} versions
 * @returns {string[]}
 */
export function filterStableVersions(versions) {
  return versions.filter((v) => semver.prerelease(v) === null);
}

/**
 * Return stable versions >= devBase, sorted ascending.
 * These are the versions that have shipped since the dev work was based.
 *
 * @param {string[]} versions  All versions from npm view
 * @param {string} devBase     e.g. '1.2.0'
 * @returns {string[]}
 */
export function getHigherStableVersions(versions, devBase) {
  return filterStableVersions(versions)
    .filter((v) => semver.gte(v, devBase))
    .sort(semver.compare);
}
