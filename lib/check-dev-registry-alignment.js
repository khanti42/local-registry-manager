import semver from 'semver';
import { isDevPrerelease } from './check-settled.js';

/**
 * Greatest published `X.Y.Z-<preid>.N` on the same release line as `declaredVersion`.
 *
 * @param {string[]} versions
 * @param {string} declaredVersion
 * @param {string} preid
 * @returns {string | null}
 */
export function latestPreidPrereleaseOnReleaseLine(
  versions,
  declaredVersion,
  preid,
) {
  if (!isDevPrerelease(declaredVersion, preid)) {
    return null;
  }
  const declaredParsed = semver.parse(declaredVersion);
  if (!declaredParsed) {
    return null;
  }
  const base = `${declaredParsed.major}.${declaredParsed.minor}.${declaredParsed.patch}`;
  const candidates = versions.filter((v) => {
    if (!isDevPrerelease(v, preid)) {
      return false;
    }
    const p = semver.parse(v);
    if (!p) {
      return false;
    }
    return `${p.major}.${p.minor}.${p.patch}` === base;
  });
  if (candidates.length === 0) {
    return null;
  }
  return candidates.reduce((a, b) => (semver.gt(b, a) ? b : a));
}
