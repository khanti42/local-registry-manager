import semver from 'semver';

/**
 * Next local test version: `x.y.z` -> `x.y.z-<preid>.1`, `x.y.z-dev.2` -> `x.y.z-dev.3`.
 *
 * @param {string} version
 * @param {string} preid
 * @returns {string}
 */
export function bumpDevVersion(version, preid) {
  const v = semver.parse(version);
  if (!v) {
    throw new Error(`Invalid semver version: ${version}`);
  }
  const pr = v.prerelease;
  if (
    pr.length >= 2 &&
    pr[0] === preid &&
    typeof pr[1] === 'number' &&
    Number.isFinite(pr[1])
  ) {
    return `${v.major}.${v.minor}.${v.patch}-${preid}.${pr[1] + 1}`;
  }
  return `${v.major}.${v.minor}.${v.patch}-${preid}.1`;
}

/**
 * Always `x.y.z-<preid>.1` from the release base (major.minor.patch), ignoring any existing prerelease.
 *
 * @param {string} version
 * @param {string} preid
 * @returns {string}
 */
export function setFixedDevPrerelease(version, preid) {
  const v = semver.parse(version);
  if (!v) {
    throw new Error(`Invalid semver version: ${version}`);
  }
  return `${v.major}.${v.minor}.${v.patch}-${preid}.1`;
}
