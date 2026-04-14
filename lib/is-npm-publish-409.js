/**
 * Detect Verdaccio/npm duplicate-version errors from captured publish output.
 *
 * @param {string} stderr
 * @param {string} stdout
 * @returns {boolean}
 */
export function isNpmPublish409Error(stderr, stdout) {
  const s = `${stderr}\n${stdout}`;
  return (
    /\bE409\b/i.test(s) ||
    /409\s+Conflict/i.test(s) ||
    /already present/i.test(s)
  );
}
