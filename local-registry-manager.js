#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { execSync, spawnSync } from 'node:child_process';
import yaml from 'js-yaml';
import semver from 'semver';
import {
  bumpDevVersion as bumpDevVersionLib,
  setFixedDevPrerelease,
} from './lib/bump-dev-version.js';
import { isNpmPublish409Error } from './lib/is-npm-publish-409.js';
import {
  extractDevBase,
  isDevPrerelease,
  getHigherStableVersions,
} from './lib/check-settled.js';

const DEFAULT_CONFIG = 'local-registry.yml';

/** Max npm publish attempts when the registry returns E409 (version already exists). */
const MAX_REGISTRY_PUBLISH_409_RETRIES = 50;

function fail(message) {
  console.error(`\nERROR: ${message}`);
  process.exit(1);
}

function section(title) {
  console.log(`\n=== ${title} ===`);
}

function subSection(title) {
  console.log(`\n--- ${title} ---`);
}

function info(message = '') {
  console.log(message);
}

function parseCsv(value) {
  if (!value) return [];
  return value.split(',').map((x) => x.trim()).filter(Boolean);
}

function printHelp() {
  console.log(`
Usage (use "yarn node" in this repo so PnP can resolve dependencies):
  yarn node local-registry-manager.js apply --changed <pkg1,pkg2,...> [options]
  yarn node local-registry-manager.js clean [options]
  yarn node local-registry-manager.js registry apply --changed <pkg1,pkg2,...> [options]
  yarn node local-registry-manager.js registry clean [options]

Commands:
  apply                  Publish/link plan from --changed and config.
  clean                  In all configured repo and consumer dirs: yalc remove for yalc-linked managed
                         packages, remove nested .yalc symlinks created by --sync-yalc-resolutions.
  registry apply         Verdaccio workflow: pin cross-repo managed deps, yarn, bump dev versions,
                         build, npm publish; then update consumer package.json and yarn.
                         Requires a running registry and publishConfig.registry (or --registry) on packages.
  registry clean         Prints manual restore hints only (does not edit files).

Options:
  --changed <csv>        Required. Managed packages you changed directly.
  --include <csv>        Optional. Managed packages to filter the publish plan (not merged with
                         --include-repo): if any appear in the transitive closure from --changed, only
                         those matches (plus --changed and their deps in that closure) are published; if
                         none match, the full closure is used. After that, --include-repo unions extra packages.
  --include-repo <csv>   Optional. Adds all managed packages in these repos to the publish/rebuild plan
                         (union with the computed publish set), then re-sorts by dependency order.
  --scope <csv>          Optional. Consumer groups to sync. Example: core,snap,extension
  --dry-run              Print the plan and commands without executing.
  --stage                git add package.json yalc.lock .yalc after yalc operations.
  --show-changelog       Print changelog excerpt for risky updates (with dry-run, risky rows only).
  --show-shell-preview   After the command list, print (cd <cwd> && <cmd>) lines (off by default).
  --from-step <n>        Run from step n onward (1 = first line in "Command list"). apply / registry apply only.
  --sync-yalc-resolutions  Before each first yarn, merge package.json resolutions where needed: publish-plan
                         packages that are direct managed deps of the target, plus transitive managed deps
                         via YAML dependsOn from those seeds (at workspace root, unions packages/). Excludes
                         same-repo packages. Uses Yarn selective parent/child keys from dependsOn when
                         possible; then yalc add at the yarn cwd; optionally symlink nested package .yalc to
                         the repo root .yalc, and relay repo .yalc into node_modules/*/.yalc and .yalc/*/.yalc
                         where package.json uses file:.yalc so nested resolution paths work.
  --legacy-global-yalc-resolutions  With --sync-yalc-resolutions, use flat \"@scope/pkg\": file:.yalc/...
                         only (no parent/child keys).
  --no-symlink-nested-yalc  With --sync-yalc-resolutions, skip nested .yalc symlinks and relay (workspace,
                         node_modules, and .yalc store copies).
  --config <path>        Config file path. Default: local-registry.yml
  --help                 Show help.

  Registry workflow (registry apply / registry clean):
  --registry <url>       npm/Verdaccio registry URL (overrides optional top-level "registry" in YAML).
  --preid <name>         Prerelease id for local bumps (default: dev) -> x.y.z-<preid>.N
  --fixed-dev-prerelease With registry apply, always set x.y.z-<preid>.1 from major.minor.patch (no N+1).
                         Use when you reset Verdaccio and want every publish at -<preid>.1. On E409, fails
                         instead of bumping (clear the registry or change the base version).
  --publish-tag <name>   Dist-tag for npm publish (default: same as --preid). Required for prereleases.
  --use-yarn-publish     Run "yarn npm publish" instead of "npm publish" in each publishDir.
  --skip-settled-check   Skip the pre-flight check that detects managed packages with new stable
                         releases on npm and prompts to graduate or remove dev pins.
  --force-registry-publish
                         With registry apply, always run npm publish even when that exact version already
                         exists on the registry (default: skip publish to avoid E409 duplicate version).
                         If publish still returns E409, the tool bumps dev.N and retries (also updates pins /
                         resolutions) until success or max attempts.
  --sync-registry-resolutions
                         Before each phase 2 or 3 yarn (not phase 1), merge semver resolutions at the workspace
                         root; package names match --sync-yalc-resolutions (declared managed deps + closure,
                         exclude same-repo). Phase 1 skipped.

  Consumer YAML (per group under consumers.<name>):
    installDir: <path>   Optional, relative to that group's repo root. When set, yarn runs there;
                         yalc update/add still run in each dir under dirs. Example: installDir: .

Examples:
  yarn node local-registry-manager.js apply \\
    --changed @metamask/utils,@metamask/keyring-api \\
    --dry-run

  yarn node local-registry-manager.js apply \\
    --changed @metamask/utils,@metamask/keyring-api,@metamask/keyring-internal-api,@metamask/eth-snap-keyring \\
    --include @metamask/accounts-controller,@metamask/bridge-controller \\
    --scope core,snap,extension
`);
}

function parseArgs(argv) {
  const args = {
    command: null,
    changed: [],
    include: [],
    includeRepo: [],
    scope: [],
    dryRun: false,
    stage: false,
    showChangelog: false,
    showShellPreview: false,
    syncYalcResolutions: false,
    syncRegistryResolutions: false,
    legacyGlobalYalcResolutions: false,
    symlinkNestedYalc: true,
    config: DEFAULT_CONFIG,
    registryUrl: null,
    preid: 'dev',
    fixedDevPrerelease: false,
    publishTag: null,
    useYarnPublish: false,
    forceRegistryPublish: false,
    fromStep: null,
    skipSettledCheck: false,
  };

  const positional = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === '--dry-run') {
      args.dryRun = true;
      continue;
    }
    if (arg === '--stage') {
      args.stage = true;
      continue;
    }
    if (arg === '--show-changelog') {
      args.showChangelog = true;
      continue;
    }
    if (arg === '--show-shell-preview') {
      args.showShellPreview = true;
      continue;
    }
    if (arg === '--sync-yalc-resolutions') {
      args.syncYalcResolutions = true;
      continue;
    }
    if (arg === '--sync-registry-resolutions') {
      args.syncRegistryResolutions = true;
      continue;
    }
    if (arg === '--legacy-global-yalc-resolutions') {
      args.legacyGlobalYalcResolutions = true;
      continue;
    }
    if (arg === '--no-symlink-nested-yalc') {
      args.symlinkNestedYalc = false;
      continue;
    }
    if (arg === '--changed') {
      args.changed = parseCsv(argv[++i]);
      continue;
    }
    if (arg.startsWith('--changed=')) {
      args.changed = parseCsv(arg.slice('--changed='.length));
      continue;
    }
    if (arg === '--include') {
      args.include = parseCsv(argv[++i]);
      continue;
    }
    if (arg === '--include-repo') {
      args.includeRepo = parseCsv(argv[++i]);
      continue;
    }
    if (arg.startsWith('--include-repo=')) {
      args.includeRepo = parseCsv(arg.slice('--include-repo='.length));
      continue;
    }
    if (arg.startsWith('--include=')) {
      args.include = parseCsv(arg.slice('--include='.length));
      continue;
    }
    if (arg === '--scope') {
      args.scope = parseCsv(argv[++i]);
      continue;
    }
    if (arg.startsWith('--scope=')) {
      args.scope = parseCsv(arg.slice('--scope='.length));
      continue;
    }
    if (arg === '--config') {
      args.config = argv[++i];
      continue;
    }
    if (arg.startsWith('--config=')) {
      args.config = arg.slice('--config='.length);
      continue;
    }
    if (arg === '--registry') {
      args.registryUrl = argv[++i];
      continue;
    }
    if (arg.startsWith('--registry=')) {
      args.registryUrl = arg.slice('--registry='.length);
      continue;
    }
    if (arg === '--preid') {
      args.preid = argv[++i];
      continue;
    }
    if (arg.startsWith('--preid=')) {
      args.preid = arg.slice('--preid='.length);
      continue;
    }
    if (arg === '--use-yarn-publish') {
      args.useYarnPublish = true;
      continue;
    }
    if (arg === '--fixed-dev-prerelease') {
      args.fixedDevPrerelease = true;
      continue;
    }
    if (arg === '--skip-settled-check') {
      args.skipSettledCheck = true;
      continue;
    }
    if (arg === '--force-registry-publish') {
      args.forceRegistryPublish = true;
      continue;
    }
    if (arg === '--publish-tag') {
      args.publishTag = argv[++i];
      continue;
    }
    if (arg.startsWith('--publish-tag=')) {
      args.publishTag = arg.slice('--publish-tag='.length);
      continue;
    }
    if (arg === '--from-step') {
      const raw = argv[++i];
      if (raw === undefined) {
        fail('--from-step requires a positive integer (1 = first command in the list)');
      }
      const n = Number.parseInt(String(raw), 10);
      if (
        !Number.isFinite(n) ||
        n < 1 ||
        String(n) !== String(raw).trim()
      ) {
        fail('--from-step must be a positive integer (1 = first command in the list)');
      }
      args.fromStep = n;
      continue;
    }
    if (arg.startsWith('--from-step=')) {
      const raw = arg.slice('--from-step='.length);
      const n = Number.parseInt(String(raw), 10);
      if (
        !Number.isFinite(n) ||
        n < 1 ||
        String(n) !== String(raw).trim()
      ) {
        fail('--from-step must be a positive integer (1 = first command in the list)');
      }
      args.fromStep = n;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
    if (arg.startsWith('--')) {
      fail(`Unknown option: ${arg}`);
    }
    positional.push(arg);
  }

  if (positional[0] === 'registry') {
    if (!positional[1]) {
      fail('registry requires a subcommand: apply | clean');
    }
    const sub = positional[1];
    if (sub !== 'apply' && sub !== 'clean') {
      fail(`Unknown registry subcommand: ${sub} (expected apply | clean)`);
    }
    args.command = `registry-${sub}`;
  } else {
    args.command = positional[0] ?? null;
  }
  return args;
}

function loadConfig(configPath) {
  const resolved = path.resolve(configPath);
  if (!fs.existsSync(resolved)) {
    fail(`Config file not found: ${resolved}`);
  }

  const raw = fs.readFileSync(resolved, 'utf8');
  const config = yaml.load(raw);

  if (!config?.repos || !config?.packages || !config?.consumers) {
    fail('Config must contain repos, packages, and consumers');
  }

  if (config.registry != null && typeof config.registry !== 'string') {
    fail('Config "registry" must be a string URL when set');
  }

  return {
    config,
    configPath: resolved,
    baseDir: path.dirname(resolved),
  };
}

function isYalcFileSpecifier(range) {
  return typeof range === 'string' && range.startsWith('file:.yalc/');
}

function isNonSemverSpecifier(range) {
  if (typeof range !== 'string') return true;

  return (
    isYalcFileSpecifier(range) ||
    range.startsWith('file:') ||
    range.startsWith('link:') ||
    range.startsWith('portal:') ||
    range.startsWith('workspace:') ||
    range.startsWith('github:') ||
    range.startsWith('git+') ||
    range.startsWith('http:') ||
    range.startsWith('https:')
  );
}

function readInstalledYalcVersion(consumerDir, pkgName) {
  const pkgPath = path.join(
    consumerDir,
    '.yalc',
    pkgName,
    'package.json',
  );

  if (!fs.existsSync(pkgPath)) {
    return null;
  }

  const json = readJson(pkgPath);
  return json?.version ?? null;
}

function resolveRepoPath(ctx, repoName) {
  const rel = ctx.config.repos[repoName];
  if (!rel) {
    fail(`Unknown repo: ${repoName}`);
  }
  return path.resolve(ctx.baseDir, rel);
}

/**
 * Longest matching repo root in config that contains `absDir`.
 *
 * @param {{ config: object, baseDir: string }} ctx
 * @param {string} absDir
 * @returns {string | null}
 */
function findRepoKeyForPath(ctx, absDir) {
  const normalized = path.resolve(absDir);
  let bestKey = null;
  let bestLen = -1;
  for (const repoKey of Object.keys(ctx.config.repos)) {
    const root = resolveRepoPath(ctx, repoKey);
    const r = path.resolve(root);
    if (normalized === r || normalized.startsWith(`${r}${path.sep}`)) {
      if (r.length > bestLen) {
        bestLen = r.length;
        bestKey = repoKey;
      }
    }
  }
  return bestKey;
}

/**
 * First consumer block whose `repo` key matches (e.g. `snap` in `repo: snap`).
 *
 * @param {{ config: object }} ctx
 * @param {string} repoKey
 * @returns {{ repo: string, installDir?: string, dirs?: string[] } | null}
 */
function findConsumerDefForRepo(ctx, repoKey) {
  for (const def of Object.values(ctx.config.consumers)) {
    if (def.repo === repoKey) {
      return def;
    }
  }
  return null;
}

/**
 * linkCwd = package dir; installCwd = repo-level yarn when `installDir` is set on the consumer group.
 *
 * @param {string} repoRoot
 * @param {string} linkCwd
 * @param {string | undefined} installDir
 */
function resolveConsumerInstallCwd(repoRoot, linkCwd, installDir) {
  if (installDir != null && String(installDir).trim() !== '') {
    return path.resolve(repoRoot, installDir);
  }
  return linkCwd;
}

/**
 * Yarn cwd for a managed package: optional `installDir` on the consumer group for this package's repo.
 *
 * @param {{ config: object, baseDir: string }} ctx
 * @param {string} pkgName
 * @returns {string}
 */
function getInstallCwdForManagedPackage(ctx, pkgName) {
  const meta = ctx.config.packages[pkgName];
  const repoRoot = resolveRepoPath(ctx, meta.repo);
  const linkCwd = path.resolve(repoRoot, meta.publishDir);
  const consumerDef = findConsumerDefForRepo(ctx, meta.repo);
  return resolveConsumerInstallCwd(
    repoRoot,
    linkCwd,
    consumerDef?.installDir,
  );
}

/**
 * Env vars so Yarn Berry and npm resolve packages from a local Verdaccio (proxies to npmjs).
 *
 * Yarn 4+ blocks plain HTTP registries unless the host is in `unsafeHttpWhitelist` (YN0081).
 * Array settings accept a comma-separated string via `YARN_UNSAFE_HTTP_WHITELIST`.
 *
 * @param {string} registryUrl
 * @returns {Record<string, string>}
 */
function getRegistryEnvForYarnInstall(registryUrl) {
  const out = {
    npm_config_registry: registryUrl,
    NPM_CONFIG_REGISTRY: registryUrl,
    YARN_NPM_REGISTRY_SERVER: registryUrl,
  };
  try {
    const u = new URL(registryUrl);
    if (u.protocol === 'http:') {
      const hosts = new Set(['localhost', '127.0.0.1']);
      if (u.hostname) {
        hosts.add(u.hostname);
      }
      out.YARN_UNSAFE_HTTP_WHITELIST = [...hosts].join(',');
    }
  } catch {
    // ignore invalid registry URL
  }
  return out;
}

/**
 * @param {string} cmd
 * @param {string} cwd
 * @param {{ dryRun?: boolean, shell?: boolean, env?: Record<string, string> | null }} [options]
 */
function run(cmd, cwd, { dryRun = false, shell = false, env: envOverrides = null } = {}) {
  console.log(`\n$ ${cmd}`);
  console.log(`  cwd: ${cwd}`);
  if (envOverrides) {
    const r = envOverrides.npm_config_registry ?? envOverrides.YARN_NPM_REGISTRY_SERVER;
    if (r) {
      console.log(`  env: npm registry -> ${r}`);
    }
    if (envOverrides.YARN_UNSAFE_HTTP_WHITELIST) {
      console.log(
        `  env: Yarn unsafeHttpWhitelist -> ${envOverrides.YARN_UNSAFE_HTTP_WHITELIST}`,
      );
    }
  }

  if (dryRun) {
    console.log('  skipped (dry-run)');
    return { ok: true, code: 0 };
  }

  try {
    const execOpts = { cwd, stdio: 'inherit', shell };
    if (envOverrides) {
      execOpts.env = { ...process.env, ...envOverrides };
    }
    execSync(cmd, execOpts);
    return { ok: true, code: 0 };
  } catch (error) {
    return { ok: false, code: typeof error.status === 'number' ? error.status : 1 };
  }
}

/**
 * Run a shell command and capture stdout/stderr (used to detect npm E409 without losing output).
 *
 * @param {string} cmd
 * @param {string} cwd
 * @param {Record<string, string> | null} envOverrides
 * @returns {{ code: number, stdout: string, stderr: string }}
 */
function spawnShellCapture(cmd, cwd, envOverrides = null) {
  const env = envOverrides ? { ...process.env, ...envOverrides } : process.env;
  const result = spawnSync(cmd, {
    cwd,
    shell: true,
    encoding: 'utf8',
    env,
  });
  return {
    code: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

/**
 * After an extra dev-version bump, keep the in-memory plan and workspace resolutions aligned.
 *
 * @param {Map<string, string>} registryVersionMap
 * @param {string} pkgName
 * @param {string} newVersion
 * @param {{ type: string, pins?: Array<{ name: string, version: string }> }[]} commands
 * @param {number} afterCommandIndex
 */
function applyVersionBumpToFuturePins(
  registryVersionMap,
  pkgName,
  newVersion,
  commands,
  afterCommandIndex,
) {
  registryVersionMap.set(pkgName, newVersion);
  for (let j = afterCommandIndex + 1; j < commands.length; j += 1) {
    const cmd = commands[j];
    if (
      cmd.type !== 'registry-pin-deps' &&
      cmd.type !== 'registry-pin-consumer-deps'
    ) {
      continue;
    }
    const pins = cmd.pins;
    if (!Array.isArray(pins)) {
      continue;
    }
    for (const pin of pins) {
      if (pin && pin.name === pkgName) {
        pin.version = newVersion;
      }
    }
  }
}

function assertKnownPackages(config, names, label) {
  const known = new Set(Object.keys(config.packages));
  const unknown = names.filter((x) => !known.has(x));
  if (unknown.length) {
    fail(`Unknown ${label}: ${unknown.join(', ')}`);
  }
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * @param {string} filePath
 * @param {unknown} data
 */
function writeJson(filePath, data) {
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

/**
 * @param {string} version
 * @param {string} preid
 * @returns {string}
 */
function bumpDevVersion(version, preid) {
  try {
    return bumpDevVersionLib(version, preid);
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e));
  }
}

/**
 * Simulated next versions for every managed package from current package.json on disk (planning / dry-run).
 *
 * @param {{ config: object, baseDir: string }} ctx
 * @param {string[]} publishOrder
 * @param {string} preid
 * @returns {Map<string, string>}
 */
function simulatePublishedVersionsMap(ctx, publishOrder, preid, fixedDevPrerelease) {
  const map = new Map();
  for (const pkgName of publishOrder) {
    const { json } = getPackageSourcePackageJson(ctx, pkgName);
    const base = json.version ?? '0.0.0';
    const next = fixedDevPrerelease
      ? setFixedDevPrerelease(base, preid)
      : bumpDevVersion(base, preid);
    map.set(pkgName, next);
  }
  return map;
}

/**
 * @param {string} packageDir
 * @param {Array<{ name: string, version: string }>} pins
 * @param {boolean} dryRun
 */
function pinExactVersionsInPackageJson(packageDir, pins, dryRun) {
  if (!pins.length) {
    return;
  }
  const filePath = path.join(packageDir, 'package.json');
  const pkg = readJson(filePath);
  if (!pkg) {
    fail(`Missing or invalid package.json: ${filePath}`);
  }
  const sections = [
    'dependencies',
    'devDependencies',
    'peerDependencies',
    'optionalDependencies',
  ];
  let changed = false;
  for (const { name, version } of pins) {
    for (const sec of sections) {
      if (pkg[sec]?.[name] !== undefined) {
        pkg[sec][name] = version;
        changed = true;
      }
    }
  }
  if (changed && !dryRun) {
    writeJson(filePath, pkg);
  }
}

/**
 * Quote a path for bash `cd` / one-liners (unquoted when safe).
 * @param {string} p
 * @returns {string}
 */
function shellQuotePath(p) {
  const s = String(p);
  if (/^[a-zA-Z0-9/_.:@+-]+$/.test(s)) {
    return s;
  }
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * @param {string} spec npm package@version (scoped names OK)
 * @returns {string}
 */
function shellQuoteNpmPackageAtVersion(spec) {
  return `'${String(spec).replace(/'/g, `'\\''`)}'`;
}

/**
 * True if `npm view` can resolve this exact version on the registry (avoids republishing / E409).
 * On lookup failure (offline, 404), returns false so publish is still attempted.
 *
 * @param {string} registryUrl
 * @param {string} packageName
 * @param {string} version
 * @returns {boolean}
 */
function isVersionPublishedOnRegistry(registryUrl, packageName, version) {
  const reg = shellQuotePath(registryUrl);
  const spec = shellQuoteNpmPackageAtVersion(`${packageName}@${version}`);
  try {
    const out = execSync(`npm view ${spec} version --registry ${reg}`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: true,
    });
    return String(out).trim() === version;
  } catch {
    return false;
  }
}

/**
 * One-line bash equivalent for (cd cwd && cmd).
 * @param {string} cwd
 * @param {string} cmd
 * @param {boolean} shell
 * @returns {string}
 */
function formatBashOneLiner(cwd, cmd, shell) {
  const q = shellQuotePath(cwd);
  if (shell) {
    return `(cd ${q} && (${cmd}))`;
  }
  return `(cd ${q} && ${cmd})`;
}

/**
 * Walk up from startDir to find a directory whose package.json defines `workspaces`.
 * @param {string} startDir
 * @returns {string | null}
 */
function findMonorepoWorkspaceRoot(startDir) {
  let cur = path.resolve(startDir);
  for (;;) {
    const pkgPath = path.join(cur, 'package.json');
    const pkg = readJson(pkgPath);
    if (pkg?.workspaces) {
      return cur;
    }
    const parent = path.dirname(cur);
    if (parent === cur) {
      break;
    }
    cur = parent;
  }
  return null;
}

/**
 * Directories that should receive flat `file:.yalc/<name>` resolutions for a given yarn cwd:
 * the monorepo root (workspace root) and, when yarn runs inside a workspace package, that package.
 * @param {string} installCwd
 * @returns {string[]}
 */
function collectDirsToSyncYalcResolutions(installCwd) {
  const abs = path.resolve(installCwd);
  const root = findMonorepoWorkspaceRoot(abs);
  const out = [];
  if (root) {
    out.push(root);
  }
  if (root && abs !== root && fs.existsSync(path.join(abs, 'package.json'))) {
    out.push(abs);
  } else if (!root) {
    const pkg = readJson(path.join(abs, 'package.json'));
    if (pkg?.workspaces) {
      out.push(abs);
    } else if (pkg) {
      out.push(abs);
    }
  }
  return out;
}

/**
 * Where to merge Yarn `resolutions` for registry dedupe: **workspace root only** (one package.json per
 * install tree). Nested workspace packages under that root are excluded so upstream monorepo
 * packages are not edited.
 *
 * @param {string} installCwd
 * @returns {string | null}
 */
function getRegistryResolutionsPackageJsonDir(installCwd) {
  const abs = path.resolve(installCwd);
  const root = findMonorepoWorkspaceRoot(abs);
  if (root) {
    return root;
  }
  const pkgPath = path.join(abs, 'package.json');
  const pkg = readJson(pkgPath);
  if (pkg?.workspaces) {
    return abs;
  }
  if (pkg) {
    return abs;
  }
  return null;
}

/**
 * Add dependency names from each packages/<name>/package.json under repoRoot.
 *
 * @param {string} repoRoot
 * @param {Set<string>} declared
 */
function unionDepsFromRepoPackagesDir(repoRoot, declared) {
  const packagesDir = path.join(repoRoot, 'packages');
  if (!fs.existsSync(packagesDir)) {
    return;
  }
  for (const ent of fs.readdirSync(packagesDir, { withFileTypes: true })) {
    if (!ent.isDirectory()) {
      continue;
    }
    const pj = path.join(packagesDir, ent.name, 'package.json');
    const j = readJson(pj);
    if (j) {
      for (const k of getDeclaredDepsWithSources(j).keys()) {
        declared.add(k);
      }
    }
  }
}

/**
 * Declared dependency names relevant for resolution scoping: this package.json, or at the repo root the
 * union of root plus each direct child under packages/ (package.json per folder). Includes repos that use
 * a packages/ layout but omit the `workspaces` field (e.g. some app repos).
 *
 * @param {{ config: object, baseDir: string }} ctx
 * @param {string} packageDir
 * @returns {Set<string>}
 */
function getDeclaredDepNamesForResolutionScope(ctx, packageDir) {
  const abs = path.resolve(packageDir);
  const workspaceRoot = findMonorepoWorkspaceRoot(abs);
  const ownerRepo = findRepoKeyForPath(ctx, abs);
  const repoRoot = ownerRepo ? resolveRepoPath(ctx, ownerRepo) : null;

  const rootPkgPath = path.join(abs, 'package.json');
  const rootPkg = readJson(rootPkgPath);
  const declared = new Set();

  if (!rootPkg) {
    return declared;
  }

  const atRepoRoot = repoRoot && path.resolve(abs) === path.resolve(repoRoot);
  const hasPackagesDir =
    repoRoot && fs.existsSync(path.join(repoRoot, 'packages'));
  const workspaceRootMatchesRepo =
    workspaceRoot && path.resolve(workspaceRoot) === path.resolve(repoRoot);

  const unionRootAndPackages =
    atRepoRoot &&
    hasPackagesDir &&
    (workspaceRootMatchesRepo || !workspaceRoot);

  if (unionRootAndPackages) {
    for (const k of getDeclaredDepsWithSources(rootPkg).keys()) {
      declared.add(k);
    }
    unionDepsFromRepoPackagesDir(repoRoot, declared);
  } else {
    for (const k of getDeclaredDepsWithSources(rootPkg).keys()) {
      declared.add(k);
    }
  }

  return declared;
}

/**
 * Managed package names that appear as direct npm dependencies in this resolution scope (root + packages/
 * union when at workspace root).
 *
 * @param {{ config: object, baseDir: string }} ctx
 * @param {string} packageDir
 * @returns {Set<string>}
 */
function getManagedDirectDepsDeclaredInScope(ctx, packageDir) {
  const declared = getDeclaredDepNamesForResolutionScope(ctx, packageDir);
  const set = new Set();
  for (const name of declared) {
    if (ctx.config.packages[name]) {
      set.add(name);
    }
  }
  return set;
}

/**
 * Subset of publish-plan names that need a flat file:.yalc resolution here:
 * - Seeds: managed packages declared directly in this scope's package.json (as above).
 * - Plus transitive managed deps: forward walk of config `dependsOn`, staying inside the publish plan
 *   (same as expandNeedWithClosureDeps).
 * - Exclude same-repo packages (workspace links).
 *
 * @param {{ config: object, baseDir: string }} ctx
 * @param {string} packageDir
 * @param {string[]} publishSetNames
 * @returns {string[]}
 */
function getPublishSetNamesForYalcResolutions(ctx, packageDir, publishSetNames) {
  const publishSet = new Set(publishSetNames);
  const directManaged = getManagedDirectDepsDeclaredInScope(ctx, packageDir);
  if (directManaged.size === 0) {
    return [];
  }

  const closure = expandNeedWithClosureDeps(
    publishSet,
    directManaged,
    ctx.config.packages,
  );

  const ownerRepo = findRepoKeyForPath(ctx, packageDir);
  const out = [];

  for (const name of closure) {
    if (!publishSet.has(name)) {
      continue;
    }
    const meta = ctx.config.packages[name];
    if (!meta) {
      continue;
    }
    if (ownerRepo && meta.repo === ownerRepo) {
      continue;
    }
    out.push(name);
  }
  out.sort((a, b) => a.localeCompare(b));
  return out;
}

/**
 * @param {Record<string, { dependsOn?: string[] }>} packages
 * @returns {Map<string, Set<string>>}
 */
function buildParentsMap(packages) {
  const parents = new Map();
  for (const [pkgName, meta] of Object.entries(packages)) {
    for (const dep of meta.dependsOn ?? []) {
      if (!parents.has(dep)) {
        parents.set(dep, new Set());
      }
      parents.get(dep).add(pkgName);
    }
  }
  return parents;
}

/**
 * Transitive managed closure from direct seeds (for parent/child resolution keys).
 *
 * @param {{ config: object, baseDir: string }} ctx
 * @param {string} packageDir
 * @param {string[]} publishSetNames
 * @returns {Set<string>}
 */
function getPublishSetClosureForResolutions(ctx, packageDir, publishSetNames) {
  const publishSet = new Set(publishSetNames);
  const directManaged = getManagedDirectDepsDeclaredInScope(ctx, packageDir);
  if (directManaged.size === 0) {
    return new Set();
  }
  return expandNeedWithClosureDeps(
    publishSet,
    directManaged,
    ctx.config.packages,
  );
}

/**
 * Yarn Classic selective resolutions: parent/child keys from YAML dependsOn when possible.
 *
 * @param {{ config: object, baseDir: string }} ctx
 * @param {string} packageDir
 * @param {string[]} publishSetNames
 * @param {{ legacyGlobalYalcResolutions?: boolean }} args
 * @returns {Map<string, string>}
 */
function buildYalcResolutionMap(ctx, packageDir, publishSetNames, args) {
  const filtered = getPublishSetNamesForYalcResolutions(ctx, packageDir, publishSetNames);
  const closure = getPublishSetClosureForResolutions(ctx, packageDir, publishSetNames);
  const parentsMap = buildParentsMap(ctx.config.packages);
  const entries = new Map();

  if (args.legacyGlobalYalcResolutions) {
    for (const dep of filtered) {
      entries.set(dep, `file:.yalc/${dep}`);
    }
    return entries;
  }

  for (const dep of filtered) {
    const flat = `file:.yalc/${dep}`;
    const parents = parentsMap.get(dep);
    let scoped = false;
    if (parents && parents.size > 0) {
      for (const parent of parents) {
        if (!closure.has(parent)) {
          continue;
        }
        entries.set(`${parent}/${dep}`, flat);
        scoped = true;
      }
    }
    if (!scoped) {
      entries.set(dep, flat);
    }
  }
  return entries;
}

/**
 * Merge file:.yalc entries into package.json resolutions; strip prior yalc pins for this publish set.
 *
 * @param {{ config: object, baseDir: string }} ctx
 * @param {string} packageDir
 * @param {string[]} publishSetNames
 * @param {{ legacyGlobalYalcResolutions?: boolean }} args
 */
function syncYalcResolutionsIntoPackageJson(ctx, packageDir, publishSetNames, args) {
  const pkgPath = path.join(packageDir, 'package.json');
  const pkg = readJson(pkgPath);
  if (!pkg) {
    return;
  }

  const resolutions = { ...(pkg.resolutions ?? {}) };

  for (const name of publishSetNames) {
    const flat = `file:.yalc/${name}`;
    const keysToRemove = [];
    for (const [k, v] of Object.entries(resolutions)) {
      if (v === flat) {
        keysToRemove.push(k);
      }
    }
    for (const k of keysToRemove) {
      delete resolutions[k];
    }
  }

  const map = buildYalcResolutionMap(ctx, packageDir, publishSetNames, args);
  for (const [k, v] of map.entries()) {
    resolutions[k] = v;
  }

  if (Object.keys(resolutions).length === 0) {
    delete pkg.resolutions;
  } else {
    pkg.resolutions = resolutions;
  }
  fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
}

/**
 * Symlink nestedDir/.yalc -> repoRoot/.yalc so nested file:.yalc/... resolves to the same store.
 *
 * @param {string} repoRoot
 * @param {string} nestedDir
 */
function ensureNestedYalcSymlink(repoRoot, nestedDir) {
  if (path.resolve(nestedDir) === path.resolve(repoRoot)) {
    return;
  }
  const target = path.join(repoRoot, '.yalc');
  const linkPath = path.join(nestedDir, '.yalc');
  if (!fs.existsSync(target)) {
    info(`  skip symlink (no ${target})`);
    return;
  }
  try {
    const stat = fs.lstatSync(linkPath);
    if (stat.isSymbolicLink()) {
      const resolved = path.resolve(nestedDir, fs.readlinkSync(linkPath));
      if (resolved === path.resolve(target)) {
        return;
      }
      fs.unlinkSync(linkPath);
    } else if (stat.isDirectory()) {
      info(`  skip symlink (${linkPath} is a directory, not a symlink)`);
      return;
    }
  } catch {
    // linkPath missing
  }
  fs.symlinkSync(target, linkPath, 'dir');
}

/**
 * True if package.json references `file:.yalc/...` in deps or resolutions.
 *
 * @param {object} pkgJson
 * @returns {boolean}
 */
function packageJsonReferencesFileYalc(pkgJson) {
  const blobs = [
    pkgJson.dependencies,
    pkgJson.devDependencies,
    pkgJson.peerDependencies,
    pkgJson.optionalDependencies,
    pkgJson.resolutions,
  ];
  for (const blob of blobs) {
    if (!blob || typeof blob !== 'object') {
      continue;
    }
    for (const v of Object.values(blob)) {
      if (typeof v === 'string' && isYalcFileSpecifier(v)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * For each package under `installRoot/node_modules` and `installRoot/.yalc` whose package.json
 * references `file:.yalc/...`, ensure `packageDir/.yalc` -> `installRoot/.yalc` so nested resolution
 * does not look for a missing nested `.yalc` path (e.g. under yalc-installed copies).
 *
 * @param {string} installRoot - Repo root where `yarn` runs and `.yalc` lives (e.g. extension root).
 */
function relayYalcSymlinksForInstallRoot(installRoot) {
  const root = path.resolve(installRoot);
  const yalcStore = path.join(root, '.yalc');
  if (!fs.existsSync(yalcStore)) {
    return;
  }

  /**
   * @param {string} pkgDir
   */
  function processPackageDir(pkgDir) {
    const pj = path.join(pkgDir, 'package.json');
    if (!fs.existsSync(pj)) {
      return;
    }
    const json = readJson(pj);
    if (!json || !packageJsonReferencesFileYalc(json)) {
      return;
    }
    ensureNestedYalcSymlink(root, pkgDir);
  }

  /**
   * @param {string} nmDir
   */
  function walkNodeModulesLevel(nmDir) {
    let entries;
    try {
      entries = fs.readdirSync(nmDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (ent.name.startsWith('.') || ent.name === '.bin') {
        continue;
      }
      const full = path.join(nmDir, ent.name);
      if (ent.name.startsWith('@')) {
        if (!ent.isDirectory()) {
          continue;
        }
        let subEntries;
        try {
          subEntries = fs.readdirSync(full, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const sub of subEntries) {
          if (!sub.isDirectory()) {
            continue;
          }
          const pkgDir = path.join(full, sub.name);
          processPackageDir(pkgDir);
          walkNodeModulesLevel(path.join(pkgDir, 'node_modules'));
        }
      } else if (ent.isDirectory()) {
        processPackageDir(full);
        walkNodeModulesLevel(path.join(full, 'node_modules'));
      }
    }
  }

  const nm = path.join(root, 'node_modules');
  if (fs.existsSync(nm)) {
    walkNodeModulesLevel(nm);
  }

  let yalcEntries;
  try {
    yalcEntries = fs.readdirSync(yalcStore, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of yalcEntries) {
    if (!ent.isDirectory()) {
      continue;
    }
    const full = path.join(yalcStore, ent.name);
    if (ent.name.startsWith('@')) {
      let subs;
      try {
        subs = fs.readdirSync(full, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const sub of subs) {
        if (!sub.isDirectory()) {
          continue;
        }
        const pkgDir = path.join(full, sub.name);
        processPackageDir(pkgDir);
        walkNodeModulesLevel(path.join(pkgDir, 'node_modules'));
      }
    } else {
      processPackageDir(full);
      walkNodeModulesLevel(path.join(full, 'node_modules'));
    }
  }
}

/**
 * Remove nested .yalc symlink if present (dev cleanup).
 *
 * @param {{ config: object, baseDir: string }} ctx
 * @param {string} dir
 */
function removeNestedYalcSymlinkIfAny(ctx, dir) {
  const repoRoot = findRepoKeyForPath(ctx, dir)
    ? resolveRepoPath(ctx, findRepoKeyForPath(ctx, dir))
    : null;
  if (!repoRoot || path.resolve(dir) === path.resolve(repoRoot)) {
    return;
  }
  const linkPath = path.join(dir, '.yalc');
  try {
    if (fs.lstatSync(linkPath).isSymbolicLink()) {
      fs.unlinkSync(linkPath);
    }
  } catch {
    // ignore
  }
}

/**
 * Managed package names that use `file:.yalc/...` in declared dependencies.
 *
 * @param {{ config: object }} ctx
 * @param {object} pkgJson
 * @returns {string[]}
 */
function getManagedYalcLinkedPackageNames(ctx, pkgJson) {
  const declared = getDeclaredDepsWithSources(pkgJson);
  const out = [];
  for (const [name, { range }] of declared.entries()) {
    if (isYalcFileSpecifier(range) && ctx.config.packages[name]) {
      out.push(name);
    }
  }
  out.sort((a, b) => a.localeCompare(b));
  return out;
}

/**
 * Remove resolution entries whose value is `file:.yalc/<managedName>` for any managed package name.
 *
 * @param {{ config: object, baseDir: string }} ctx
 * @param {string} packageDir
 */
function stripYalcManagedResolutionsFromPackageJson(ctx, packageDir) {
  const pkgPath = path.join(packageDir, 'package.json');
  const pkg = readJson(pkgPath);
  if (!pkg?.resolutions) {
    return;
  }
  const managedNames = new Set(Object.keys(ctx.config.packages));
  const resolutions = { ...pkg.resolutions };
  let changed = false;
  for (const [k, v] of Object.entries(resolutions)) {
    if (typeof v !== 'string' || !isYalcFileSpecifier(v)) {
      continue;
    }
    const rest = v.slice('file:.yalc/'.length);
    if (managedNames.has(rest)) {
      delete resolutions[k];
      changed = true;
    }
  }
  if (!changed) {
    return;
  }
  if (Object.keys(resolutions).length === 0) {
    delete pkg.resolutions;
  } else {
    pkg.resolutions = resolutions;
  }
  fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
}

/**
 * Repo roots, consumer link/install dirs, and managed package publish dirs (deduped).
 *
 * @param {{ config: object, baseDir: string }} ctx
 * @param {string[]} scope
 * @returns {string[]}
 */
function collectAllCleanDirectories(ctx, scope) {
  const seen = new Set();
  const out = [];

  for (const repoKey of Object.keys(ctx.config.repos)) {
    const root = path.resolve(resolveRepoPath(ctx, repoKey));
    if (!seen.has(root)) {
      seen.add(root);
      out.push(root);
    }
  }

  const consumers = getConsumersToProcess(ctx, scope);
  for (const c of consumers) {
    for (const d of [c.absoluteDir, c.installCwd]) {
      const abs = path.resolve(d);
      if (!seen.has(abs)) {
        seen.add(abs);
        out.push(abs);
      }
    }
  }

  for (const meta of Object.values(ctx.config.packages)) {
    const repoRoot = resolveRepoPath(ctx, meta.repo);
    const dir = path.resolve(repoRoot, meta.publishDir);
    if (!seen.has(dir)) {
      seen.add(dir);
      out.push(dir);
    }
  }

  return out;
}

/**
 * Insert sync-resolutions steps and matching `yalc add` at the yarn cwd before the first yarn at each cwd.
 * Root-level yalc add is required when yarn runs at the repo root (e.g. installDir: .) so file:.yalc/<name>
 * from resolutions points at materialized packages under that cwd's .yalc.
 *
 * @param {Array<{ type: string, phase: number, cwd: string, cmd: string, shell?: boolean }>} commands
 * @param {string[]} publishSet
 * @param {{ syncYalcResolutions?: boolean }} args
 * @param {{ config: object, baseDir: string }} ctx
 * @returns {typeof commands}
 */
function injectResolutionsSteps(commands, publishSet, args, ctx) {
  if (!args.syncYalcResolutions || publishSet.length === 0) {
    return commands;
  }
  const seenInstallCwd = new Set();
  const seenSyncedDirs = new Set();
  const seenNestedSymlink = new Set();
  const out = [];
  for (const c of commands) {
    if (
      c.type === 'install' &&
      c.cmd === 'yarn' &&
      !seenInstallCwd.has(c.cwd)
    ) {
      const installAbs = path.resolve(c.cwd);
      const dirs = collectDirsToSyncYalcResolutions(c.cwd);
      const names = getPublishSetNamesForYalcResolutions(
        ctx,
        installAbs,
        publishSet,
      );
      if (dirs.length || names.length) {
        seenInstallCwd.add(c.cwd);
        for (const dir of dirs) {
          const absDir = path.resolve(dir);
          if (seenSyncedDirs.has(absDir)) {
            continue;
          }
          seenSyncedDirs.add(absDir);
          out.push({
            type: 'sync-resolutions',
            phase: c.phase ?? 0,
            cwd: absDir,
            cmd: `merge scoped yalc resolutions in ${path.basename(absDir)} (publish plan: ${publishSet.length} package(s))`,
          });
        }
        for (const dep of names) {
          out.push({
            type: 'link',
            phase: c.phase ?? 0,
            cwd: installAbs,
            cmd: `yalc add ${dep}`,
            shell: true,
          });
        }
        if (args.symlinkNestedYalc && names.length) {
          out.push({
            type: 'relay-yalc',
            phase: c.phase ?? 0,
            cwd: installAbs,
            cmd: `relay .yalc symlinks under node_modules and .yalc (install root: ${installAbs})`,
          });
        }
        if (args.symlinkNestedYalc) {
          for (const dir of dirs) {
            const absDir = path.resolve(dir);
            const repoKey = findRepoKeyForPath(ctx, absDir);
            if (!repoKey) {
              continue;
            }
            const repoRoot = resolveRepoPath(ctx, repoKey);
            if (path.resolve(absDir) === path.resolve(repoRoot)) {
              continue;
            }
            if (seenNestedSymlink.has(absDir)) {
              continue;
            }
            seenNestedSymlink.add(absDir);
            out.push({
              type: 'symlink-nested-yalc',
              phase: c.phase ?? 0,
              cwd: absDir,
              repoRoot,
              cmd: `symlink ${path.join(absDir, '.yalc')} -> ${path.join(repoRoot, '.yalc')}`,
            });
          }
        }
      }
    }
    out.push(c);
  }
  return out;
}

/**
 * Merge exact semver pins into `package.json` `resolutions` using the **same package-name filter as yalc**
 * (`getPublishSetNamesForYalcResolutions`): declared managed deps in this scope, transitive closure inside
 * the publish plan, exclude same-repo workspace packages — then pin those names to registry versions.
 * Removes `resolutions[name]` for publish-plan names that yalc would not pin here (stale keys).
 *
 * @param {{ config: object, baseDir: string }} ctx
 * @param {string} packageDir
 * @param {string[]} publishSetNames
 * @param {Map<string, string>} versionMap
 */
function syncRegistryResolutionsIntoPackageJson(
  ctx,
  packageDir,
  publishSetNames,
  versionMap,
) {
  const filePath = path.join(packageDir, 'package.json');
  const pkg = readJson(filePath);
  if (!pkg) {
    fail(`Missing or invalid package.json: ${filePath}`);
  }
  const filtered = getPublishSetNamesForYalcResolutions(
    ctx,
    packageDir,
    publishSetNames,
  );
  const filteredSet = new Set(filtered);
  const next = { ...(pkg.resolutions ?? {}) };
  for (const name of publishSetNames) {
    if (filteredSet.has(name)) {
      const ver = versionMap.get(name);
      if (ver) {
        next[name] = ver;
      }
    } else {
      delete next[name];
    }
  }
  pkg.resolutions = next;
  writeJson(filePath, pkg);
}

/**
 * Insert registry resolution-merge steps before the first `yarn` at each install cwd for **phase 2 and 3**
 * only. Phase 1 (first publish wave, e.g. accounts) is skipped so those repos are not touched. Phase 2
 * covers intermediate monorepos that publish after phase 1 (e.g. core); phase 3 is `consumers` in YAML.
 * Writes only the workspace root `package.json`, not nested `packages/*` workspaces.
 *
 * @param {Array<{ type: string, phase?: number, cwd: string, cmd: string, shell?: boolean }>} commands
 * @param {string[]} publishSet
 * @param {{ syncRegistryResolutions?: boolean }} args
 * @param {{ config: object, baseDir: string }} ctx
 * @returns {typeof commands}
 */
function injectRegistryResolutionsSteps(commands, publishSet, args, ctx) {
  if (!args.syncRegistryResolutions || publishSet.length === 0) {
    return commands;
  }
  const seenInstallCwd = new Set();
  const seenSyncedDirs = new Set();
  const out = [];
  for (const c of commands) {
    if (
      c.type === 'install' &&
      c.cmd === 'yarn' &&
      (c.phase === 2 || c.phase === 3) &&
      !seenInstallCwd.has(c.cwd)
    ) {
      const absDir = getRegistryResolutionsPackageJsonDir(c.cwd);
      if (absDir) {
        seenInstallCwd.add(c.cwd);
        if (!seenSyncedDirs.has(absDir)) {
          seenSyncedDirs.add(absDir);
          const filtered = getPublishSetNamesForYalcResolutions(
            ctx,
            absDir,
            publishSet,
          );
          out.push({
            type: 'registry-sync-resolutions',
            phase: c.phase ?? 0,
            cwd: absDir,
            cmd: `merge resolutions (registry dedupe, yalc filter) in ${path.basename(absDir)} (${filtered.length}/${publishSet.length} package(s))`,
          });
        }
      }
    }
    out.push(c);
  }
  return out;
}

function readPackageJson(dir) {
  const file = path.join(dir, 'package.json');
  if (!fs.existsSync(file)) return null;
  const json = readJson(file);
  if (!json) fail(`Invalid package.json: ${file}`);
  return json;
}

function getPackagesFromRepos(config, repoNames) {
  const result = [];

  for (const repoName of repoNames) {
    if (!config.repos[repoName]) {
      fail(`Unknown repo: ${repoName}`);
    }

    for (const [pkgName, meta] of Object.entries(config.packages)) {
      if (meta.repo === repoName) {
        result.push(pkgName);
      }
    }
  }

  return result;
}

function getPackageSourceDir(ctx, pkgName) {
  const meta = ctx.config.packages[pkgName];
  const repoRoot = resolveRepoPath(ctx, meta.repo);
  return path.resolve(repoRoot, meta.publishDir);
}

/**
 * @param {{ config: object, baseDir: string }} ctx
 * @param {string} absoluteDir
 * @returns {string | null}
 */
function findManagedPackageForAbsoluteDir(ctx, absoluteDir) {
  const normalized = path.resolve(absoluteDir);
  for (const [pkgName, meta] of Object.entries(ctx.config.packages)) {
    const repoRoot = resolveRepoPath(ctx, meta.repo);
    const dir = path.resolve(repoRoot, meta.publishDir);
    if (dir === normalized) {
      return pkgName;
    }
  }
  return null;
}

/**
 * Union packages from --include-repo into the plan and re-sort publish order.
 *
 * @param {{ config: object, baseDir: string }} ctx
 * @param {object} plan
 * @param {string[]} includeRepoNames
 */
function augmentPlanWithIncludeRepos(ctx, plan, includeRepoNames) {
  if (!includeRepoNames.length) {
    return plan;
  }

  const publishSet = new Set(plan.publishSet);
  const repoPkgs = getPackagesFromRepos(ctx.config, includeRepoNames);

  for (const p of repoPkgs) {
    if (!publishSet.has(p)) {
      if (!plan.reasonMap.has(p)) {
        plan.reasonMap.set(p, []);
      }
      plan.reasonMap.get(p).push('included via --include-repo');
    }
    publishSet.add(p);
  }

  plan.publishSet = [...publishSet];
  plan.publishOrder = topoSortSubset(ctx.config.packages, plan.publishSet);
  return plan;
}

/**
 * Ancestors of `changed` within `publishSet` (walk `dependsOn` backward), union `changed`.
 *
 * @param {string[]} changed
 * @param {string[]} publishSet
 * @param {Record<string, { dependsOn?: string[] }>} packages
 * @returns {Set<string>}
 */
function computePhase1PackageSet(changed, publishSet, packages) {
  const set = new Set(publishSet);
  const ancestors = new Set();
  const stack = [...changed];

  while (stack.length) {
    const p = stack.pop();
    for (const dep of packages[p]?.dependsOn ?? []) {
      if (set.has(dep) && !ancestors.has(dep)) {
        ancestors.add(dep);
        stack.push(dep);
      }
    }
  }

  const phase1 = new Set([...ancestors, ...changed]);
  return phase1;
}

function getPackageSourcePackageJson(ctx, pkgName) {
  const dir = getPackageSourceDir(ctx, pkgName);
  const json = readPackageJson(dir);
  if (!json) {
    fail(`Missing package.json for managed package ${pkgName} in ${dir}`);
  }
  return { dir, json };
}

function getDeclaredDepsWithSources(pkgJson) {
  const sources = [
    ['dependencies', pkgJson.dependencies ?? {}],
    ['devDependencies', pkgJson.devDependencies ?? {}],
    ['peerDependencies', pkgJson.peerDependencies ?? {}],
    ['optionalDependencies', pkgJson.optionalDependencies ?? {}],
  ];

  const map = new Map();
  for (const [sourceName, deps] of sources) {
    for (const [name, range] of Object.entries(deps)) {
      if (!map.has(name)) {
        map.set(name, { range, source: sourceName });
      }
    }
  }
  return map;
}

function buildReverseGraph(packages) {
  const reverse = new Map();
  for (const name of Object.keys(packages)) reverse.set(name, []);

  for (const [pkgName, meta] of Object.entries(packages)) {
    for (const dep of meta.dependsOn ?? []) {
      if (!reverse.has(dep)) reverse.set(dep, []);
      reverse.get(dep).push(pkgName);
    }
  }
  return reverse;
}

/**
 * Add all transitive `dependsOn` edges that stay inside `visitedSet`.
 *
 * @param {Set<string>} visitedSet - Transitive closure from --changed
 * @param {Set<string>} need - Seeds (e.g. changed ∪ intersection)
 * @param {Record<string, { dependsOn?: string[] }>} packages
 * @returns {Set<string>}
 */
function expandNeedWithClosureDeps(visitedSet, need, packages) {
  const result = new Set(need);
  let grew = true;
  while (grew) {
    grew = false;
    for (const pkg of result) {
      for (const dep of packages[pkg]?.dependsOn ?? []) {
        if (visitedSet.has(dep) && !result.has(dep)) {
          result.add(dep);
          grew = true;
        }
      }
    }
  }
  return result;
}

function buildClosureFromChanged(config, changed) {
  const reverse = buildReverseGraph(config.packages);
  const reasonMap = new Map();

  function addReason(pkg, reason) {
    if (!reasonMap.has(pkg)) reasonMap.set(pkg, []);
    const arr = reasonMap.get(pkg);
    if (!arr.includes(reason)) arr.push(reason);
  }

  const visited = new Set();
  const queue = [];

  for (const pkg of changed) {
    queue.push({ pkg, via: null, kind: 'changed' });
  }

  while (queue.length) {
    const { pkg, via, kind } = queue.shift();

    if (!visited.has(pkg)) {
      visited.add(pkg);
    }

    if (kind === 'changed') {
      addReason(pkg, 'changed');
    } else if (kind === 'affected') {
      addReason(pkg, `affected via ${via}`);
    }

    for (const downstream of reverse.get(pkg) ?? []) {
      if (!reasonMap.has(downstream) || !reasonMap.get(downstream).includes(`affected via ${pkg}`)) {
        queue.push({ pkg: downstream, via: pkg, kind: 'affected' });
      }
    }
  }

  return { visited, reasonMap };
}

function buildReasonMapRestricted(changed, intersection, expanded) {
  const reasonMap = new Map();
  const changedSet = new Set(changed);
  const intersectionSet = new Set(intersection);

  function addReason(pkg, reason) {
    if (!reasonMap.has(pkg)) reasonMap.set(pkg, []);
    const arr = reasonMap.get(pkg);
    if (!arr.includes(reason)) arr.push(reason);
  }

  for (const pkg of expanded) {
    if (changedSet.has(pkg)) {
      addReason(pkg, 'changed');
    } else if (intersectionSet.has(pkg)) {
      addReason(pkg, 'included');
    } else {
      addReason(pkg, 'dependency of included publish set');
    }
  }

  return reasonMap;
}

/**
 * @param {string[]} explicitIncludes - Unique packages from --include and --include-repo
 */
function buildApplyPlan(config, changed, explicitIncludes) {
  const { visited, reasonMap: closureReasonMap } = buildClosureFromChanged(
    config,
    changed,
  );

  const explicitSet = new Set(explicitIncludes);
  const explicitRequested = [...explicitIncludes];

  if (explicitRequested.length === 0) {
    const publishSet = [...visited];
    const publishOrder = topoSortSubset(config.packages, publishSet);
    return {
      changed: [...changed],
      include: [],
      includeFilterNote: null,
      publishSet,
      publishOrder,
      reasonMap: closureReasonMap,
    };
  }

  const intersection = [...visited].filter((p) => explicitSet.has(p));

  if (intersection.length === 0) {
    const publishSet = [...visited];
    const publishOrder = topoSortSubset(config.packages, publishSet);
    return {
      changed: [...changed],
      include: explicitRequested,
      includeFilterNote:
        'None of the --include/--include-repo packages are in the transitive closure from --changed; using the full closure (all affected packages).',
      publishSet,
      publishOrder,
      reasonMap: closureReasonMap,
    };
  }

  const need = new Set([...changed, ...intersection]);
  const expanded = expandNeedWithClosureDeps(visited, need, config.packages);
  const publishSet = [...expanded];
  const publishOrder = topoSortSubset(config.packages, publishSet);
  const reasonMap = buildReasonMapRestricted(changed, intersection, publishSet);

  return {
    changed: [...changed],
    include: explicitRequested,
    includeFilterNote:
      'Restricting publish set to --changed, matching --include/--include-repo entries in the closure, and their dependencies within that closure.',
    publishSet,
    publishOrder,
    reasonMap,
  };
}

function topoSortSubset(packages, subset) {
  const subsetSet = new Set(subset);
  const inDegree = new Map();
  const graph = new Map();

  for (const pkg of subset) {
    inDegree.set(pkg, 0);
    graph.set(pkg, []);
  }

  for (const pkg of subset) {
    for (const dep of packages[pkg].dependsOn ?? []) {
      if (!subsetSet.has(dep)) continue;
      inDegree.set(pkg, inDegree.get(pkg) + 1);
      graph.get(dep).push(pkg);
    }
  }

  const queue = [];
  for (const [pkg, degree] of inDegree.entries()) {
    if (degree === 0) queue.push(pkg);
  }

  const ordered = [];
  while (queue.length) {
    const current = queue.shift();
    ordered.push(current);
    for (const next of graph.get(current)) {
      const degree = inDegree.get(next) - 1;
      inDegree.set(next, degree);
      if (degree === 0) queue.push(next);
    }
  }

  if (ordered.length !== subset.length) {
    fail('Dependency cycle detected in managed package graph');
  }

  return ordered;
}

/**
 * @param {string[]} changed
 * @param {string[]} publishSet
 * @param {Record<string, { dependsOn?: string[] }>} packages
 */
function partitionPublishPhases(changed, publishSet, packages) {
  const set = new Set(publishSet);
  const phase1Set = computePhase1PackageSet(changed, publishSet, packages);
  const phase1Members = [...set].filter((p) => phase1Set.has(p));
  const phase1Packages = topoSortSubset(packages, phase1Members);
  const phase2Members = [...set].filter((p) => !phase1Set.has(p));
  const phase2Packages = topoSortSubset(packages, phase2Members);
  return { phase1Packages, phase2Packages };
}

function getConsumersToProcess(ctx, scope) {
  const groups = Object.keys(ctx.config.consumers);
  const selected = scope.length ? scope : groups;

  for (const group of selected) {
    if (!ctx.config.consumers[group]) fail(`Unknown consumer scope: ${group}`);
  }

  const consumers = [];
  for (const group of selected) {
    const def = ctx.config.consumers[group];
    const repoRoot = resolveRepoPath(ctx, def.repo);

    for (const dir of def.dirs ?? []) {
      const linkCwd = path.resolve(repoRoot, dir);
      const installCwd = resolveConsumerInstallCwd(repoRoot, linkCwd, def.installDir);
      consumers.push({
        group,
        dir,
        absoluteDir: linkCwd,
        installCwd,
      });
    }
  }

  return consumers;
}

function classifyVersionChange({ declaredRange, localVersion, consumerDir, pkgName }) {
  const cleanLocal = semver.valid(localVersion);

  if (isYalcFileSpecifier(declaredRange)) {
    const installedYalcVersion = readInstalledYalcVersion(consumerDir, pkgName);

    if (cleanLocal && semver.valid(installedYalcVersion)) {
      const diff = semver.diff(installedYalcVersion, cleanLocal) ?? 'none';

      return {
        mode: 'yalc',
        compatible: null,
        changeType: normalizeDiff(diff),
        fromVersion: installedYalcVersion,
        toVersion: cleanLocal,
        installedYalcVersion,
      };
    }

    return {
      mode: 'yalc',
      compatible: null,
      changeType: 'already-yalc',
      fromVersion: installedYalcVersion,
      toVersion: cleanLocal,
      installedYalcVersion,
    };
  }

  if (isNonSemverSpecifier(declaredRange)) {
    return {
      mode: 'non-semver',
      compatible: null,
      changeType: 'unknown',
      fromVersion: null,
      toVersion: cleanLocal,
      installedYalcVersion: null,
    };
  }

  const minFrom = semver.minVersion(declaredRange);

  if (!cleanLocal || !minFrom) {
    return {
      mode: 'semver',
      compatible: null,
      changeType: 'unknown',
      fromVersion: minFrom?.version ?? null,
      toVersion: cleanLocal,
      installedYalcVersion: null,
    };
  }

  return {
    mode: 'semver',
    compatible: semver.satisfies(cleanLocal, declaredRange, { includePrerelease: true }),
    changeType: normalizeDiff(semver.diff(minFrom.version, cleanLocal) ?? 'none'),
    fromVersion: minFrom.version,
    toVersion: cleanLocal,
    installedYalcVersion: null,
  };
}

function normalizeDiff(diff) {
  if (diff === 'premajor') return 'major';
  if (diff === 'preminor') return 'minor';
  if (diff === 'prepatch') return 'patch';
  return diff;
}

function findChangelogCandidates(ctx, pkgName) {
  const { dir } = getPackageSourcePackageJson(ctx, pkgName);
  const repoRoot = resolveRepoPath(ctx, ctx.config.packages[pkgName].repo);

  const candidates = [
    path.join(dir, 'CHANGELOG.md'),
    path.join(dir, 'Changelog.md'),
    path.join(dir, 'changelog.md'),
    path.join(repoRoot, 'CHANGELOG.md'),
    path.join(repoRoot, 'Changelog.md'),
    path.join(repoRoot, 'changelog.md'),
  ];

  return [...new Set(candidates)].filter((p) => fs.existsSync(p));
}

function extractChangelogSnippet(filePath, targetVersion) {
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split(/\r?\n/);

  const normalized = targetVersion.replace(/^v/, '');
  const headingRegex = /^(#{1,6}\s+.+|##?\s*\[?.+\]?|#+\s*\[?.+\]?)/i;

  let start = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].includes(normalized) && headingRegex.test(lines[i])) {
      start = i;
      break;
    }
  }

  if (start === -1) {
    const preview = lines.slice(0, 30).join('\n').trim();
    return preview || null;
  }

  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (headingRegex.test(lines[i])) {
      end = i;
      break;
    }
  }

  return lines.slice(start, Math.min(end, start + 40)).join('\n').trim();
}

function getChangelogInfo(ctx, pkgName) {
  const { json } = getPackageSourcePackageJson(ctx, pkgName);
  const version = json.version;
  const candidates = findChangelogCandidates(ctx, pkgName);

  if (!candidates.length) return null;

  const filePath = candidates[0];
  const snippet = version ? extractChangelogSnippet(filePath, version) : null;

  return {
    filePath,
    version,
    snippet,
  };
}

function getImpactForConsumer(ctx, consumer, plan) {
  const pkgJson = readPackageJson(consumer.absoluteDir);
  if (!pkgJson) {
    return {
      consumer,
      exists: false,
      impacts: [],
    };
  }

  const declared = getDeclaredDepsWithSources(pkgJson);
  const impacts = [];

  for (const pkgName of plan.publishOrder) {
    if (!declared.has(pkgName)) continue;

    const { json: sourcePkgJson } = getPackageSourcePackageJson(ctx, pkgName);
    const localVersion = sourcePkgJson.version ?? null;
    const declaredInfo = declared.get(pkgName);
    const declaredRange = declaredInfo.range;
    const declaredSource = declaredInfo.source;
    const semverInfo = classifyVersionChange({
      declaredRange,
      localVersion,
      consumerDir: consumer.absoluteDir,
      pkgName,
    });
    const reasons = plan.reasonMap.get(pkgName) ?? [];

    const risky =
      semverInfo.mode === 'semver' && (
        semverInfo.compatible === false ||
        semverInfo.changeType === 'major' ||
        semverInfo.changeType === 'unknown'
      );

    impacts.push({
      pkgName,
      declaredRange,
      declaredSource,
      localVersion,
      semverInfo,
      reasons,
      risky,
    });
  }

  return {
    consumer,
    exists: true,
    impacts,
  };
}

function printPlan(plan, consumers, args, phase1Packages, phase2Packages) {
  section('Plan');
  info(`Mode: ${args.dryRun ? 'dry-run' : 'execute'}`);
  info(`Changed: ${plan.changed.join(', ')}`);
  info(`Included: ${plan.include.length ? plan.include.join(', ') : '(none)'}`);
  if (plan.includeFilterNote) {
    info(`Include filter: ${plan.includeFilterNote}`);
  }
  info(`Scopes: ${args.scope.length ? args.scope.join(', ') : '(all)'}`);
  info(`Consumers: ${consumers.map((c) => `${c.group}:${c.dir}`).join(', ')}`);
  info(`Publish order (full): ${plan.publishOrder.join(' -> ')}`);

  subSection('Phase 1 (upstream + changed)');
  info(phase1Packages.length ? phase1Packages.join(' -> ') : '(none)');

  subSection('Phase 2 (downstream managed)');
  info(phase2Packages.length ? phase2Packages.join(' -> ') : '(none)');

  subSection('Publish reasons');
  for (const pkg of plan.publishOrder) {
    const reasons = plan.reasonMap.get(pkg) ?? [];
    info(`- ${pkg}: ${reasons.join('; ')}`);
  }
}

const IMPACT_COL_WIDTHS = [40, 28, 25, 14, 10, 8];
const IMPACT_EXCERPT_MAX_LINES = 6;
const IMPACT_EXCERPT_MAX_CHARS = 400;

function truncateCell(str, max) {
  const s = String(str);
  if (s.length <= max) return s;
  return `${s.slice(0, Math.max(0, max - 3))}...`;
}

/**
 * @param {{ mode: string, compatible: boolean | null }} semverInfo
 */
function formatOkColumn(semverInfo) {
  if (semverInfo.mode === 'yalc') return 'yalc';
  if (semverInfo.compatible === true) return 'yes';
  if (semverInfo.compatible === false) return 'no';
  return 'unknown';
}

function formatImpactTableRow(cols) {
  const parts = cols.map((c, i) =>
    truncateCell(String(c), IMPACT_COL_WIDTHS[i]).padEnd(IMPACT_COL_WIDTHS[i]),
  );
  info(`  ${parts.join('  ')}`);
}

function impactTableSeparator() {
  info(`  ${IMPACT_COL_WIDTHS.map((w) => '-'.repeat(w)).join('  ')}`);
}

function capChangelogExcerpt(text) {
  const lines = text.split(/\r?\n/).slice(0, IMPACT_EXCERPT_MAX_LINES);
  let out = lines.join('\n');
  if (out.length > IMPACT_EXCERPT_MAX_CHARS) {
    out = `${out.slice(0, IMPACT_EXCERPT_MAX_CHARS)}...`;
  }
  return out;
}

function printImpactReport(ctx, impactReports, args) {
  section('Consumer impact');

  for (const report of impactReports) {
    const label = `${report.consumer.group}:${report.consumer.dir}`;

    if (!report.exists) {
      info(`\n${label}`);
      info('  no package.json');
      continue;
    }

    if (!report.impacts.length) {
      info(`\n${label}`);
      info('  no relevant managed deps declared');
      continue;
    }

    info(`\n${label}`);

    formatImpactTableRow([
      'package',
      'reason',
      'declared',
      'local',
      'change',
      'ok',
    ]);
    impactTableSeparator();

    for (const impact of report.impacts) {
      const reason = impact.reasons.join('; ');
      const declared = String(impact.declaredRange).includes('yalc')
        ? 'yalc'
        : `${impact.declaredRange} (${impact.declaredSource})`;
      const local = impact.localVersion ?? '(none)';
      const change = impact.semverInfo.changeType;
      const ok = formatOkColumn(impact.semverInfo);

      formatImpactTableRow([
        impact.pkgName,
        reason,
        declared,
        local,
        change,
        ok,
      ]);

      const shouldShowChangelog =
        impact.risky && (args.showChangelog || args.dryRun);
      
    }
  }
}

/**
 * Managed deps declared in `publishDir` that were already published earlier in this run.
 *
 * @param {{ config: object, baseDir: string }} ctx
 * @param {string} pkgName
 * @param {Set<string>} publishSet
 * @param {string[]} fullOrder
 * @param {Map<string, number>} fullOrderIndex
 */
/**
 * Managed deps in the same monorepo (same `repo` key in config) are already workspace-linked;
 * do not run yalc for them.
 *
 * @param {{ config: object }} ctx
 * @param {string} ownerPkgName
 * @param {string} depPkgName
 */
function isSameRepoManagedDep(ctx, ownerPkgName, depPkgName) {
  const owner = ctx.config.packages[ownerPkgName];
  const dep = ctx.config.packages[depPkgName];
  if (!owner || !dep) {
    return false;
  }
  return owner.repo === dep.repo;
}

function getRelinkDepsOrdered(ctx, pkgName, publishSet, fullOrder, fullOrderIndex) {
  const idx = fullOrderIndex.get(pkgName);
  if (idx === undefined) {
    return [];
  }
  const prior = new Set(fullOrder.slice(0, idx));
  const { json } = getPackageSourcePackageJson(ctx, pkgName);
  const declared = getDeclaredDepsWithSources(json);
  const out = [];
  for (const name of declared.keys()) {
    if (!ctx.config.packages[name]) continue;
    if (isSameRepoManagedDep(ctx, pkgName, name)) continue;
    if (publishSet.has(name) && prior.has(name)) {
      out.push(name);
    }
  }
  out.sort(
    (a, b) => (fullOrderIndex.get(a) ?? 0) - (fullOrderIndex.get(b) ?? 0),
  );
  return out;
}

/**
 * @param {1 | 2} phase
 * @param {{ symlinkNestedYalc?: boolean }} args
 * @returns {{ type: string, phase: number, cwd: string, cmd: string, shell?: boolean }[]}
 */
function planManagedPackageCommands(
  ctx,
  pkgName,
  phase,
  publishSet,
  fullOrder,
  fullOrderIndex,
  args,
) {
  const meta = ctx.config.packages[pkgName];
  const repoRoot = resolveRepoPath(ctx, meta.repo);
  const publishDir = path.resolve(repoRoot, meta.publishDir);
  const relinkDeps = getRelinkDepsOrdered(
    ctx,
    pkgName,
    publishSet,
    fullOrder,
    fullOrderIndex,
  );
  const commands = [];

  const installCwd = getInstallCwdForManagedPackage(ctx, pkgName);

  for (const dep of relinkDeps) {
    commands.push({
      type: 'link',
      phase,
      cwd: publishDir,
      cmd: `yalc add ${dep}`,
      shell: true,
    });
  }

  if (args.symlinkNestedYalc && relinkDeps.length) {
    commands.push({
      type: 'relay-yalc',
      phase,
      cwd: installCwd,
      cmd: `relay .yalc symlinks under node_modules and .yalc (install root: ${installCwd})`,
    });
  }

  commands.push({ type: 'install', phase, cwd: installCwd, cmd: 'yarn' });

  const build = String(meta.build ?? '').trim();
  if (build) {
    commands.push({ type: 'publish', phase, cwd: repoRoot, cmd: build });
  }
  commands.push({ type: 'publish', phase, cwd: publishDir, cmd: 'yalc publish' });
  return commands;
}

/**
 * @param {{ config: object, baseDir: string }} ctx
 * @param {{ group: string, dir: string, absoluteDir: string, installCwd: string }} consumer
 * @param {{ pkgName: string }[]} impacts
 * @param {{ stage: boolean, symlinkNestedYalc?: boolean }} options
 * @returns {{ type: string, phase: number, cwd: string, cmd: string, shell?: boolean }[]}
 */
function planLinkCommands(ctx, consumer, impacts, options) {
  if (!impacts.length) {
    return [];
  }

  const consumerRepoKey = ctx.config.consumers[consumer.group]?.repo;
  const { absoluteDir, installCwd } = consumer;
  const { stage, symlinkNestedYalc } = options;
  const commands = [];

  for (const impact of impacts) {
    const depMeta = ctx.config.packages[impact.pkgName];
    if (
      consumerRepoKey != null &&
      depMeta &&
      depMeta.repo === consumerRepoKey
    ) {
      continue;
    }
    const dep = impact.pkgName;
    commands.push({
      type: 'link',
      phase: 3,
      cwd: absoluteDir,
      cmd: `yalc add ${dep}`,
      shell: true,
    });
  }

  if (symlinkNestedYalc && commands.some((x) => x.type === 'link')) {
    commands.push({
      type: 'relay-yalc',
      phase: 3,
      cwd: installCwd,
      cmd: `relay .yalc symlinks under node_modules and .yalc (install root: ${installCwd})`,
    });
  }

  commands.push({ type: 'install', phase: 3, cwd: installCwd, cmd: 'yarn' });

  if (stage) {
    commands.push({
      type: 'git',
      phase: 3,
      cwd: absoluteDir,
      cmd: 'git add package.json yalc.lock .yalc',
    });
  }

  return commands;
}

/**
 * @param {{ config: object, baseDir: string }} ctx
 * @param {{ registryUrl?: string | null }} args
 * @returns {string}
 */
function getResolvedRegistryUrl(args, ctx) {
  return args.registryUrl ?? ctx.config.registry ?? 'http://localhost:4873';
}

/**
 * npm requires `--tag` when publishing prereleases; default tag matches `--preid` (usually "dev").
 *
 * @param {{ publishTag?: string | null, preid?: string }} args
 * @returns {string}
 */
function getResolvedPublishTag(args) {
  return args.publishTag ?? args.preid ?? 'dev';
}

/**
 * @param {{ fromStep?: number | null }} args
 * @returns {number}
 */
function getFromStep(args) {
  return args.fromStep ?? 1;
}

/**
 * @param {number} fromStep
 * @param {number} commandCount
 */
function assertFromStepInRange(fromStep, commandCount) {
  if (commandCount > 0 && fromStep > commandCount) {
    fail(
      `--from-step ${fromStep} exceeds command list length (${commandCount})`,
    );
  }
}

/**
 * @param {{ config: object, baseDir: string }} ctx
 * @param {object} plan
 * @param {string[]} phase1Packages
 * @param {string[]} phase2Packages
 * @param {object[]} impactReports
 * @param {object} args
 * @param {Map<string, string>} versionMap
 */
function buildRegistryCommandPlan(
  ctx,
  plan,
  phase1Packages,
  phase2Packages,
  impactReports,
  args,
  versionMap,
) {
  const publishSet = new Set(plan.publishSet);
  const fullOrder = [...phase1Packages, ...phase2Packages];
  const fullOrderIndex = new Map(fullOrder.map((p, i) => [p, i]));
  const commands = [];

  for (const pkgName of phase1Packages) {
    commands.push(
      ...planRegistryManagedPackageCommands(
        ctx,
        pkgName,
        1,
        publishSet,
        fullOrder,
        fullOrderIndex,
        args,
        versionMap,
      ),
    );
  }

  for (const pkgName of phase2Packages) {
    commands.push(
      ...planRegistryManagedPackageCommands(
        ctx,
        pkgName,
        2,
        publishSet,
        fullOrder,
        fullOrderIndex,
        args,
        versionMap,
      ),
    );
  }

  for (const report of impactReports) {
    if (!report.exists || report.impacts.length === 0) {
      continue;
    }
    if (
      findManagedPackageForAbsoluteDir(ctx, report.consumer.absoluteDir) !== null
    ) {
      continue;
    }
    commands.push(
      ...planRegistryConsumerCommands(ctx, report.consumer, report.impacts, versionMap, {
        stage: args.stage,
      }),
    );
  }

  return commands;
}

/**
 * @param {{ config: object, baseDir: string }} ctx
 * @param {string} pkgName
 * @param {number} phase
 * @param {Set<string>} publishSet
 * @param {string[]} fullOrder
 * @param {Map<string, number>} fullOrderIndex
 * @param {object} args
 * @param {Map<string, string>} versionMap
 */
function planRegistryManagedPackageCommands(
  ctx,
  pkgName,
  phase,
  publishSet,
  fullOrder,
  fullOrderIndex,
  args,
  versionMap,
) {
  const meta = ctx.config.packages[pkgName];
  const repoRoot = resolveRepoPath(ctx, meta.repo);
  const publishDir = path.resolve(repoRoot, meta.publishDir);
  const relinkDeps = getRelinkDepsOrdered(
    ctx,
    pkgName,
    publishSet,
    fullOrder,
    fullOrderIndex,
  );
  const installCwd = getInstallCwdForManagedPackage(ctx, pkgName);
  const commands = [];

  const pins = relinkDeps
    .map((d) => ({ name: d, version: versionMap.get(d) }))
    .filter((x) => x.version);

  if (pins.length) {
    commands.push({
      type: 'registry-pin-deps',
      phase,
      cwd: publishDir,
      pins,
      cmd: `pin deps: ${pins.map((p) => `${p.name}@${p.version}`).join(', ')}`,
    });
  }

  commands.push({ type: 'install', phase, cwd: installCwd, cmd: 'yarn' });

  const nextVer = versionMap.get(pkgName);
  commands.push({
    type: 'registry-bump',
    phase,
    cwd: publishDir,
    pkgName,
    preid: args.preid,
    cmd: `bump ${pkgName} to ${nextVer ?? '(unknown)'}`,
  });

  const build = String(meta.build ?? '').trim();
  if (build) {
    commands.push({
      type: 'run-cmd',
      phase,
      cwd: repoRoot,
      cmd: build,
      shell: true,
    });
  }

  const regUrl = args.registryUrlResolved ?? 'http://localhost:4873';
  const distTag = args.publishTagResolved ?? getResolvedPublishTag(args);
  const pubCmd = args.useYarnPublish ? 'yarn npm publish' : 'npm publish';
  commands.push({
    type: 'registry-npm-publish',
    phase,
    cwd: publishDir,
    cmd: `${pubCmd} --registry ${regUrl} --tag ${distTag}`,
  });

  return commands;
}

/**
 * @param {{ config: object, baseDir: string }} ctx
 * @param {{ group: string, dir: string, absoluteDir: string, installCwd: string }} consumer
 * @param {object[]} impacts
 * @param {Map<string, string>} versionMap
 * @param {{ stage: boolean }} options
 */
function planRegistryConsumerCommands(ctx, consumer, impacts, versionMap, options) {
  if (!impacts.length) {
    return [];
  }

  const consumerRepoKey = ctx.config.consumers[consumer.group]?.repo;
  const { absoluteDir, installCwd } = consumer;
  const { stage } = options;
  const commands = [];

  const pins = [];
  for (const impact of impacts) {
    const depMeta = ctx.config.packages[impact.pkgName];
    if (
      consumerRepoKey != null &&
      depMeta &&
      depMeta.repo === consumerRepoKey
    ) {
      continue;
    }
    const ver = versionMap.get(impact.pkgName);
    if (!ver) {
      continue;
    }
    pins.push({ name: impact.pkgName, version: ver });
  }

  if (pins.length) {
    commands.push({
      type: 'registry-pin-consumer-deps',
      phase: 3,
      cwd: absoluteDir,
      pins,
      cmd: `pin consumer deps: ${pins.map((p) => `${p.name}@${p.version}`).join(', ')}`,
    });
  }

  commands.push({ type: 'install', phase: 3, cwd: installCwd, cmd: 'yarn' });

  if (stage) {
    commands.push({
      type: 'git',
      phase: 3,
      cwd: absoluteDir,
      cmd: 'git add package.json',
    });
  }

  return commands;
}

/**
 * @param {{ type: string, phase?: number, cwd: string, cmd: string, shell?: boolean, pins?: object[] }[]} commands
 * @param {boolean} dryRun
 * @param {{ ctx?: object, args?: object, registryUrl?: string, fromStep?: number, registryPublishSet?: string[], registryVersionMap?: Map<string, string> }} options
 */
function executeRegistryCommands(commands, dryRun, options = {}) {
  const {
    ctx,
    args,
    registryUrl,
    fromStep: fromStepOption,
    registryPublishSet = [],
    registryVersionMap = new Map(),
  } = options;
  const useYarnPublish = args?.useYarnPublish === true;
  const total = commands.length;
  const fromStep = fromStepOption ?? 1;
  const regArg = shellQuotePath(registryUrl ?? 'http://localhost:4873');
  const tagArg = shellQuotePath(
    args?.publishTagResolved ?? getResolvedPublishTag(args ?? {}),
  );

  /** Workspace dirs that already ran `registry-sync-resolutions` (re-sync after E409 version bump). */
  const syncedResolutionsDirs = [];

  for (let i = 0; i < commands.length; i += 1) {
    const c = commands[i];
    const commandNumber = i + 1;

    if (commandNumber < fromStep) {
      info(
        `(skip step ${commandNumber}/${total}; --from-step ${fromStep})`,
      );
      continue;
    }

    if (c.type === 'registry-sync-resolutions') {
      if (dryRun) {
        continue;
      }
      if (!ctx) {
        fail('Internal error: ctx is required for registry-sync-resolutions');
      }
      syncRegistryResolutionsIntoPackageJson(
        ctx,
        c.cwd,
        registryPublishSet,
        registryVersionMap,
      );
      if (!syncedResolutionsDirs.includes(c.cwd)) {
        syncedResolutionsDirs.push(c.cwd);
      }
      continue;
    }

    if (c.type === 'registry-pin-deps' || c.type === 'registry-pin-consumer-deps') {
      if (dryRun) {
        continue;
      }
      pinExactVersionsInPackageJson(c.cwd, c.pins ?? [], false);
      continue;
    }

    if (c.type === 'registry-bump') {
      if (dryRun) {
        continue;
      }
      const filePath = path.join(c.cwd, 'package.json');
      const pkg = readJson(filePath);
      if (!pkg) {
        fail(`Missing package.json: ${filePath}`);
      }
      const preid = c.preid ?? args?.preid ?? 'dev';
      const base = pkg.version ?? '0.0.0';
      const next =
        args?.fixedDevPrerelease === true
          ? setFixedDevPrerelease(base, preid)
          : bumpDevVersion(base, preid);
      pkg.version = next;
      writeJson(filePath, pkg);
      continue;
    }

    if (c.type === 'registry-npm-publish') {
      const registryUrlResolved = registryUrl ?? 'http://localhost:4873';
      const preidForBump = args?.preid ?? 'dev';
      const pubCmd = useYarnPublish
        ? `yarn npm publish --registry ${regArg} --tag ${tagArg}`
        : `npm publish --registry ${regArg} --tag ${tagArg}`;

      if (dryRun) {
        run(pubCmd, c.cwd, { dryRun: true, shell: true });
        continue;
      }

      if (args?.forceRegistryPublish !== true) {
        const filePath = path.join(c.cwd, 'package.json');
        const pkg = readJson(filePath);
        const pkgName = pkg?.name;
        const pkgVersion = pkg?.version;
        if (
          typeof pkgName === 'string' &&
          pkgName.length > 0 &&
          typeof pkgVersion === 'string' &&
          pkgVersion.length > 0 &&
          isVersionPublishedOnRegistry(registryUrlResolved, pkgName, pkgVersion)
        ) {
          info(
            `Skip npm publish: ${pkgName}@${pkgVersion} already exists on ${registryUrlResolved} (use --force-registry-publish to publish anyway).`,
          );
          continue;
        }
      }

      let attempt = 0;
      let lastCapture = { code: 1, stdout: '', stderr: '' };
      while (attempt < MAX_REGISTRY_PUBLISH_409_RETRIES) {
        attempt += 1;
        console.log(`\n$ ${pubCmd}`);
        console.log(`  cwd: ${c.cwd}`);
        lastCapture = spawnShellCapture(pubCmd, c.cwd, null);
        if (lastCapture.stdout) {
          process.stdout.write(lastCapture.stdout);
        }
        if (lastCapture.stderr) {
          process.stderr.write(lastCapture.stderr);
        }
        if (lastCapture.code === 0) {
          break;
        }
        if (!isNpmPublish409Error(lastCapture.stderr, lastCapture.stdout)) {
          const bash = formatBashOneLiner(c.cwd, pubCmd, true);
          console.error('\nERROR: Command failed.');
          console.error(`  command: ${commandNumber} of ${total}`);
          console.error(`  ${bash}`);
          console.error(`  exit code: ${lastCapture.code}`);
          fail(`Command ${commandNumber} failed [${c.type}]: ${pubCmd}`);
        }
        if (args?.fixedDevPrerelease === true) {
          fail(
            `Command ${commandNumber}: npm publish returned E409 (version already exists). With --fixed-dev-prerelease the version stays at x.y.z-<preid>.1 and is not incremented. Remove the package from Verdaccio, bump major/minor/patch in package.json if you need a new tarball, or omit --fixed-dev-prerelease to allow dev.N+1 retries.`,
          );
        }
        if (attempt >= MAX_REGISTRY_PUBLISH_409_RETRIES) {
          fail(
            `Command ${commandNumber}: npm publish still returned E409 after ${MAX_REGISTRY_PUBLISH_409_RETRIES} attempt(s) (${pubCmd}).`,
          );
        }
        const pkgPath = path.join(c.cwd, 'package.json');
        const pkg = readJson(pkgPath);
        const pkgName = pkg?.name;
        const prevVer = pkg?.version;
        if (
          typeof pkgName !== 'string' ||
          pkgName.length === 0 ||
          typeof prevVer !== 'string' ||
          prevVer.length === 0
        ) {
          fail(
            `Command ${commandNumber}: cannot bump after E409 (missing name/version in ${pkgPath}).`,
          );
        }
        const bumped = bumpDevVersion(prevVer, preidForBump);
        info(
          `Registry publish conflict (E409); bumping ${pkgName} ${prevVer} -> ${bumped} and retrying (publish attempt ${attempt + 1}/${MAX_REGISTRY_PUBLISH_409_RETRIES})...`,
        );
        pkg.version = bumped;
        writeJson(pkgPath, pkg);
        applyVersionBumpToFuturePins(
          registryVersionMap,
          pkgName,
          bumped,
          commands,
          i,
        );
        if (ctx && syncedResolutionsDirs.length > 0) {
          for (const dir of syncedResolutionsDirs) {
            syncRegistryResolutionsIntoPackageJson(
              ctx,
              dir,
              registryPublishSet,
              registryVersionMap,
            );
          }
        }
      }
      continue;
    }

    if (c.type === 'run-cmd') {
      const res = run(c.cmd, c.cwd, { dryRun, shell: c.shell === true });
      if (!res.ok) {
        const bash = formatBashOneLiner(c.cwd, c.cmd, c.shell === true);
        console.error('\nERROR: Command failed.');
        console.error(`  command: ${commandNumber} of ${total}`);
        console.error(`  ${bash}`);
        console.error(`  exit code: ${res.code}`);
        fail(`Command ${commandNumber} failed [${c.type}]: ${c.cmd}`);
      }
      continue;
    }

    if (c.type === 'install' || c.type === 'git') {
      const registryUrlResolved = registryUrl ?? 'http://localhost:4873';
      const useRegistryForYarn =
        c.type === 'install' && String(c.cmd).trim() === 'yarn';
      const res = run(c.cmd, c.cwd, {
        dryRun,
        shell: c.shell === true,
        env: useRegistryForYarn
          ? getRegistryEnvForYarnInstall(registryUrlResolved)
          : null,
      });
      if (!res.ok) {
        const bash = formatBashOneLiner(c.cwd, c.cmd, c.shell === true);
        console.error('\nERROR: Command failed.');
        console.error(`  command: ${commandNumber} of ${total}`);
        console.error(`  ${bash}`);
        console.error(`  exit code: ${res.code}`);
        fail(`Command ${commandNumber} failed [${c.type}]: ${c.cmd}`);
      }
      continue;
    }

    fail(`Unknown registry workflow command type: ${c.type}`);
  }
}

/**
 * @param {{ type: string, phase?: number, cwd: string, cmd: string, shell?: boolean }[]} commands
 * @param {{ showShellPreview?: boolean }} args
 */
function printCommandList(commands, args) {
  section('Command list');
  if (!commands.length) {
    info('(no commands)');
    return;
  }

  for (let i = 0; i < commands.length; i += 1) {
    const c = commands[i];
    const phase = c.phase ?? 0;
    const label = c.cmd ?? c.type;
    info(`${i + 1}. [phase ${phase}] ${c.cwd} :: ${label}`);
  }

  if (args.showShellPreview) {
    subSection('Shell-friendly preview');
    for (const c of commands) {
      if (c.type === 'sync-resolutions') {
        info(
          `# ${c.cwd}: ${c.cmd} (local-registry-manager writes package.json resolutions; no shell step)`,
        );
        continue;
      }
      if (c.type === 'symlink-nested-yalc') {
        info(
          `# ${c.cwd}: ${c.cmd} (local-registry-manager creates symlink; no shell step)`,
        );
        continue;
      }
      if (c.type === 'relay-yalc') {
        info(`# ${c.cwd}: ${c.cmd} (local-registry-manager; no shell step)`);
        continue;
      }
      if (
        c.type === 'clean-unlink-nested' ||
        c.type === 'clean-strip-resolutions'
      ) {
        info(`# ${c.cwd}: ${c.cmd} (local-registry-manager; no shell step)`);
        continue;
      }
      if (
        c.type === 'registry-pin-deps' ||
        c.type === 'registry-pin-consumer-deps' ||
        c.type === 'registry-bump' ||
        c.type === 'registry-sync-resolutions'
      ) {
        info(
          `# ${c.cwd}: ${c.cmd} (local-registry-manager writes package.json; no shell step)`,
        );
        continue;
      }
      const q = shellQuotePath(c.cwd);
      if (c.shell) {
        info(`(cd ${q} && (${c.cmd}))`);
      } else {
        info(`(cd ${q} && ${c.cmd})`);
      }
    }
  }
}

/**
 * @param {{ type: string, cwd: string, cmd: string, shell?: boolean, repoRoot?: string }[]} commands
 * @param {boolean} dryRun
 * @param {{ publishSet?: string[], ctx?: object, args?: { legacyGlobalYalcResolutions?: boolean }, fromStep?: number }} [options]
 */
function executeCommands(commands, dryRun, options = {}) {
  const publishSet = options.publishSet ?? [];
  const { ctx } = options;
  const cmdArgs = options.args ?? { legacyGlobalYalcResolutions: false };
  const total = commands.length;
  const fromStep = options.fromStep ?? 1;
  for (let i = 0; i < commands.length; i += 1) {
    const c = commands[i];
    const commandNumber = i + 1;

    if (commandNumber < fromStep) {
      info(
        `(skip step ${commandNumber}/${total}; --from-step ${fromStep})`,
      );
      continue;
    }

    if (c.type === 'sync-resolutions') {
      if (dryRun) {
        continue;
      }
      if (!ctx) {
        fail('Internal error: ctx is required for sync-yalc-resolutions');
      }
      syncYalcResolutionsIntoPackageJson(ctx, c.cwd, publishSet, cmdArgs);
      continue;
    }
    if (c.type === 'symlink-nested-yalc') {
      if (dryRun) {
        continue;
      }
      if (!ctx) {
        fail('Internal error: ctx is required for symlink-nested-yalc');
      }
      if (!c.repoRoot) {
        fail('Internal error: symlink-nested-yalc missing repoRoot');
      }
      ensureNestedYalcSymlink(c.repoRoot, c.cwd);
      continue;
    }
    if (c.type === 'relay-yalc') {
      if (dryRun) {
        continue;
      }
      relayYalcSymlinksForInstallRoot(c.cwd);
      continue;
    }
    if (c.type === 'clean-unlink-nested') {
      if (dryRun) {
        continue;
      }
      if (!ctx) {
        fail('Internal error: ctx is required for clean-unlink-nested');
      }
      removeNestedYalcSymlinkIfAny(ctx, c.cwd);
      continue;
    }
    if (c.type === 'clean-strip-resolutions') {
      if (dryRun) {
        continue;
      }
      if (!ctx) {
        fail('Internal error: ctx is required for clean-strip-resolutions');
      }
      stripYalcManagedResolutionsFromPackageJson(ctx, c.cwd);
      continue;
    }
    const res = run(c.cmd, c.cwd, { dryRun, shell: c.shell === true });
    if (!res.ok) {
      const bash = formatBashOneLiner(c.cwd, c.cmd, c.shell === true);
      console.error('\nERROR: Command failed.');
      console.error(`  command: ${commandNumber} of ${total}`);
      console.error(`  ${bash}`);
      console.error(`  exit code: ${res.code}`);
      fail(`Command ${commandNumber} failed [${c.type}]: ${c.cmd}`);
    }
  }
}

function buildCommandPlan(ctx, plan, phase1Packages, phase2Packages, impactReports, args) {
  const publishSet = new Set(plan.publishSet);
  const fullOrder = [...phase1Packages, ...phase2Packages];
  const fullOrderIndex = new Map(fullOrder.map((p, i) => [p, i]));
  const commands = [];

  for (const pkgName of phase1Packages) {
    commands.push(
      ...planManagedPackageCommands(
        ctx,
        pkgName,
        1,
        publishSet,
        fullOrder,
        fullOrderIndex,
        args,
      ),
    );
  }

  for (const pkgName of phase2Packages) {
    commands.push(
      ...planManagedPackageCommands(
        ctx,
        pkgName,
        2,
        publishSet,
        fullOrder,
        fullOrderIndex,
        args,
      ),
    );
  }

  for (const report of impactReports) {
    if (!report.exists || report.impacts.length === 0) {
      continue;
    }
    if (findManagedPackageForAbsoluteDir(ctx, report.consumer.absoluteDir) !== null) {
      continue;
    }
    commands.push(
      ...planLinkCommands(ctx, report.consumer, report.impacts, {
        stage: args.stage,
        symlinkNestedYalc: args.symlinkNestedYalc,
      }),
    );
  }

  return commands;
}

// ---------------------------------------------------------------------------
// Settled-version preflight
// ---------------------------------------------------------------------------

const PUBLIC_NPM_REGISTRY = 'https://registry.npmjs.org';

/**
 * Fetch all published versions of a package from the public npm registry.
 * Returns an empty array on any error (package not found, offline, etc.).
 *
 * @param {string} packageName
 * @returns {string[]}
 */
function fetchPublicNpmVersions(packageName) {
  try {
    const spec = shellQuoteNpmPackageAtVersion(packageName);
    const out = execSync(
      `npm view ${spec} versions --json --registry ${PUBLIC_NPM_REGISTRY}`,
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], shell: true },
    );
    const parsed = JSON.parse(out.trim());
    if (Array.isArray(parsed)) return parsed;
    // npm view returns a bare string when there is only one published version
    if (typeof parsed === 'string') return [parsed];
    return [];
  } catch {
    return [];
  }
}

/**
 * Scan every consumer dir defined in config and collect managed packages that
 * are currently pinned to a dev prerelease (x.y.z-<preid>.N).
 *
 * Returns a map: packageName -> { devVersion, dirs[] }
 * where dirs is the list of absolute consumer dirs that carry the pin.
 *
 * @param {{ config: object, baseDir: string }} ctx
 * @param {string} preid
 * @returns {Map<string, { devVersion: string, dirs: string[] }>}
 */
function findDevPinsAcrossConsumers(ctx, preid) {
  const managedNames = new Set(Object.keys(ctx.config.packages));
  const result = new Map();

  for (const consumerGroup of Object.values(ctx.config.consumers)) {
    const repoRoot = resolveRepoPath(ctx, consumerGroup.repo);
    const dirs = consumerGroup.dirs ?? ['.'];

    for (const dir of dirs) {
      const absDir = path.resolve(repoRoot, dir);
      const pkgPath = path.join(absDir, 'package.json');
      const pkg = readJson(pkgPath);
      if (!pkg) continue;

      const depFields = ['dependencies', 'devDependencies', 'peerDependencies'];
      for (const field of depFields) {
        const deps = pkg[field];
        if (!deps || typeof deps !== 'object') continue;

        for (const [name, version] of Object.entries(deps)) {
          if (!managedNames.has(name)) continue;
          if (typeof version !== 'string') continue;
          if (!isDevPrerelease(version, preid)) continue;

          if (!result.has(name)) {
            result.set(name, { devVersion: version, dirs: [] });
          }
          const entry = result.get(name);
          // Keep the highest dev version seen (should be the same everywhere,
          // but guard against drift across consumer dirs).
          if (semver.gt(version, entry.devVersion)) {
            entry.devVersion = version;
          }
          entry.dirs.push(pkgPath);
        }
      }
    }
  }

  return result;
}

/**
 * Read one line from stdin synchronously.
 * Writes the prompt to stdout first.
 *
 * @param {string} question
 * @returns {string}
 */
function promptSync(question) {
  process.stdout.write(question);
  try {
    const buf = Buffer.allocUnsafe(1024);
    const n = fs.readSync(0 /* stdin fd */, buf, 0, 1024);
    return buf.slice(0, n).toString('utf8').replace(/\r?\n$/, '').trim();
  } catch {
    return '';
  }
}

/**
 * Interactively ask the user what to do with a settled package.
 * Returns { action: 'graduate', stableVersion } or { action: 'continue' }.
 *
 * @param {string} pkgName
 * @param {string} devVersion   e.g. '1.2.0-dev.3'
 * @param {string[]} higherVersions  sorted ascending, e.g. ['1.2.1', '1.3.0']
 * @returns {{ action: 'graduate', stableVersion: string } | { action: 'continue' }}
 */
function promptSettledPackage(pkgName, devVersion, higherVersions) {
  const latest = higherVersions[higherVersions.length - 1];
  const devBase = extractDevBase(devVersion);

  info();
  info(`  ${pkgName} — new stable versions since dev base (${devBase}):`);
  higherVersions.forEach((v, i) => {
    const tag = v === latest ? '  (latest)' : '';
    info(`    [${i + 1}] ${v}${tag}`);
  });
  info();

  // Which stable version to graduate to (only asked if graduating)
  let chosenVersion = latest;
  if (higherVersions.length > 1) {
    const raw = promptSync(
      `  Settle on which version? [1–${higherVersions.length}, default: ${higherVersions.length}] `,
    );
    if (raw !== '') {
      const idx = Number.parseInt(raw, 10) - 1;
      if (idx >= 0 && idx < higherVersions.length) {
        chosenVersion = higherVersions[idx];
      }
    }
  }

  const choice = promptSync(
    `  [g] Graduate consumers to ${chosenVersion}\n` +
      `  [d] Continue on dev — remove pin, rebase to pick up from main\n` +
      `  Choice? [default: g] `,
  );

  if (choice.toLowerCase() === 'd') {
    return { action: 'continue' };
  }
  return { action: 'graduate', stableVersion: chosenVersion };
}

/**
 * For each consumer package.json path in dirs, update the dependency entry
 * for pkgName: replace with newVersion when provided, or delete the key when
 * newVersion is null (continue-on-dev path).
 *
 * @param {string} pkgName
 * @param {string[]} pkgJsonPaths
 * @param {string | null} newVersion  null = remove the pin
 * @param {boolean} dryRun
 */
function applySettledPinChange(pkgName, pkgJsonPaths, newVersion, dryRun) {
  const depFields = ['dependencies', 'devDependencies', 'peerDependencies'];
  for (const pkgPath of pkgJsonPaths) {
    const pkg = readJson(pkgPath);
    if (!pkg) continue;

    let changed = false;
    for (const field of depFields) {
      if (pkg[field]?.[pkgName] !== undefined) {
        if (newVersion === null) {
          delete pkg[field][pkgName];
        } else {
          pkg[field][pkgName] = newVersion;
        }
        changed = true;
      }
    }

    if (changed) {
      if (dryRun) {
        const action =
          newVersion === null
            ? `remove pin for ${pkgName}`
            : `pin ${pkgName} -> ${newVersion}`;
        info(`    [dry-run] would ${action} in ${pkgPath}`);
      } else {
        writeJson(pkgPath, pkg);
      }
    }
  }
}

/**
 * Pre-flight check run at the start of `registry apply`.
 * Scans consumer pins, checks public npm for settled versions, and
 * interactively asks the user to graduate or continue for each one.
 *
 * Skipped entirely when --dry-run (prints a report instead) or when
 * stdin is not a TTY (CI safety).
 *
 * @param {{ config: object, baseDir: string }} ctx
 * @param {{ preid: string, dryRun: boolean }} args
 */
function runSettledPreflight(ctx, args) {
  const { preid, dryRun } = args;
  const devPins = findDevPinsAcrossConsumers(ctx, preid);

  if (devPins.size === 0) return;

  // Collect settled packages first (one npm view per package)
  const settled = [];
  for (const [pkgName, { devVersion, dirs }] of devPins) {
    const devBase = extractDevBase(devVersion);
    const allVersions = fetchPublicNpmVersions(pkgName);
    const higher = getHigherStableVersions(allVersions, devBase);
    if (higher.length > 0) {
      settled.push({ pkgName, devVersion, dirs, higher });
    }
  }

  if (settled.length === 0) return;

  section('Settled-version check');

  if (dryRun) {
    info('The following managed packages have new stable releases on npm:');
    for (const { pkgName, devVersion, higher } of settled) {
      const latest = higher[higher.length - 1];
      info(
        `  ${pkgName}: dev pin ${devVersion} — latest stable ${latest} (${higher.join(', ')})`,
      );
    }
    info('(dry-run: skipping interactive prompts — re-run without --dry-run to act)');
    return;
  }

  if (!process.stdin.isTTY) {
    info('stdin is not a TTY — skipping interactive settled-version prompts.');
    info('Pass --skip-settled-check to suppress this message.');
    return;
  }

  info(
    `${settled.length} managed package(s) may have settled on npm. ` +
      `Please choose an action for each:`,
  );

  for (const { pkgName, devVersion, dirs, higher } of settled) {
    const decision = promptSettledPackage(pkgName, devVersion, higher);

    if (decision.action === 'graduate') {
      info(
        `  → Graduating ${pkgName}: pinning consumers to ${decision.stableVersion}`,
      );
      applySettledPinChange(pkgName, dirs, decision.stableVersion, false);
    } else {
      info(
        `  → Removing dev pin for ${pkgName} from consumers. Rebase your branch — the version will come from main.`,
      );
      applySettledPinChange(pkgName, dirs, null, false);
    }
  }

  info();
}

function registryApplyCommand(args) {
  if (!args.changed.length) {
    fail('registry apply requires --changed');
  }

  const ctx = loadConfig(args.config);
  const registryUrlResolved = getResolvedRegistryUrl(args, ctx);
  args.registryUrlResolved = registryUrlResolved;
  args.publishTagResolved = getResolvedPublishTag(args);

  assertKnownPackages(ctx.config, args.include, 'included packages');
  if (args.includeRepo.length) {
    getPackagesFromRepos(ctx.config, args.includeRepo);
  }

  assertKnownPackages(ctx.config, args.changed, 'changed packages');

  if (!args.skipSettledCheck) {
    runSettledPreflight(ctx, args);
  }

  let plan = buildApplyPlan(ctx.config, args.changed, args.include);
  plan = augmentPlanWithIncludeRepos(ctx, plan, args.includeRepo);

  const { phase1Packages, phase2Packages } = partitionPublishPhases(
    args.changed,
    plan.publishSet,
    ctx.config.packages,
  );

  const consumers = getConsumersToProcess(ctx, args.scope);
  const impactReports = consumers.map((consumer) =>
    getImpactForConsumer(ctx, consumer, plan),
  );

  const versionMap = simulatePublishedVersionsMap(
    ctx,
    plan.publishOrder,
    args.preid,
    args.fixedDevPrerelease === true,
  );

  printPlan(plan, consumers, args, phase1Packages, phase2Packages);
  section('Registry (Verdaccio)');
  info(`Registry URL: ${registryUrlResolved}`);
  info(`Preid: ${args.preid}`);
  if (args.fixedDevPrerelease) {
    info(
      'Fixed prerelease: each managed package version -> x.y.z-<preid>.1 (no automatic N+1; E409 fails instead of bumping).',
    );
  }
  info(`Publish dist-tag: ${args.publishTagResolved}`);
  info(`Publish command: ${args.useYarnPublish ? 'yarn npm publish' : 'npm publish'}`);
  if (args.syncRegistryResolutions) {
    info(
      'Sync registry resolutions: before phase 2 and 3 yarn, merge semver pins (same name filter as yalc sync-resolutions; no nested packages/*).',
    );
  }

  printImpactReport(ctx, impactReports, args);

  let commands = buildRegistryCommandPlan(
    ctx,
    plan,
    phase1Packages,
    phase2Packages,
    impactReports,
    args,
    versionMap,
  );
  commands = injectRegistryResolutionsSteps(commands, plan.publishSet, args, ctx);
  printCommandList(commands, args);

  assertFromStepInRange(getFromStep(args), commands.length);
  if (getFromStep(args) > 1) {
    section('Resume');
    info(
      `--from-step ${getFromStep(args)}: ${args.dryRun ? 'would skip' : 'will skip'} steps 1–${getFromStep(args) - 1}.`,
    );
    info('Only use this when those steps already completed successfully.');
  }

  if (args.dryRun) {
    section('Done');
    info('Dry-run: no commands executed.');
    return;
  }

  executeRegistryCommands(commands, false, {
    ctx,
    args,
    registryUrl: registryUrlResolved,
    fromStep: getFromStep(args),
    registryPublishSet: plan.publishSet,
    registryVersionMap: versionMap,
  });
  section('Done');
}

function registryCleanCommand(args) {
  if (args.fromStep != null && args.fromStep > 1) {
    fail('--from-step is only supported for apply and registry apply');
  }
  section('registry clean');
  info('This command does not modify files.');
  info('Restore package.json after a local Verdaccio workflow with git, for example:');
  info('  git checkout -- package.json packages/**/package.json');
  info('Remove or edit repo-local .npmrc if you pointed registry at Verdaccio.');
  info('');
  const ctx = loadConfig(args.config);
  info('Configured paths (reference):');
  const dirs = collectAllCleanDirectories(ctx, args.scope);
  for (const d of dirs) {
    info(`  ${d}`);
  }
  section('Done');
}

function applyCommand(args) {
  if (!args.changed.length) {
    fail('apply requires --changed');
  }

  const ctx = loadConfig(args.config);

  assertKnownPackages(ctx.config, args.include, 'included packages');
  if (args.includeRepo.length) {
    getPackagesFromRepos(ctx.config, args.includeRepo);
  }

  assertKnownPackages(ctx.config, args.changed, 'changed packages');

  let plan = buildApplyPlan(ctx.config, args.changed, args.include);
  plan = augmentPlanWithIncludeRepos(ctx, plan, args.includeRepo);

  const { phase1Packages, phase2Packages } = partitionPublishPhases(
    args.changed,
    plan.publishSet,
    ctx.config.packages,
  );

  const consumers = getConsumersToProcess(ctx, args.scope);
  const impactReports = consumers.map((consumer) => getImpactForConsumer(ctx, consumer, plan));

  printPlan(plan, consumers, args, phase1Packages, phase2Packages);
  printImpactReport(ctx, impactReports, args);

  let commands = buildCommandPlan(
    ctx,
    plan,
    phase1Packages,
    phase2Packages,
    impactReports,
    args,
  );
  commands = injectResolutionsSteps(commands, plan.publishSet, args, ctx);
  printCommandList(commands, args);

  assertFromStepInRange(getFromStep(args), commands.length);
  if (getFromStep(args) > 1) {
    section('Resume');
    info(
      `--from-step ${getFromStep(args)}: ${args.dryRun ? 'would skip' : 'will skip'} steps 1–${getFromStep(args) - 1}.`,
    );
    info('Only use this when those steps already completed successfully.');
  }

  if (args.dryRun) {
    section('Done');
    info('Dry-run: no commands executed.');
    return;
  }

  executeCommands(commands, false, {
    publishSet: plan.publishSet,
    ctx,
    args,
    fromStep: getFromStep(args),
  });

  section('Done');
}

/**
 * @param {{ config: object, baseDir: string }} ctx
 * @param {string[]} dirs
 * @returns {{ type: string, phase?: number, cwd: string, cmd: string, shell?: boolean }[]}
 */
function buildCleanCommands(ctx, dirs) {
  const commands = [];
  for (const dir of dirs) {
    const pkgPath = path.join(dir, 'package.json');
    if (!fs.existsSync(pkgPath)) {
      continue;
    }
    const pkg = readJson(pkgPath);
    if (!pkg) {
      continue;
    }
    const names = getManagedYalcLinkedPackageNames(ctx, pkg);
    commands.push({
      type: 'clean-unlink-nested',
      phase: 0,
      cwd: dir,
      cmd: 'remove nested .yalc symlink if any',
    });
    for (const name of names) {
      commands.push({
        type: 'link',
        phase: 0,
        cwd: dir,
        cmd: `yalc remove ${name}`,
        shell: true,
      });
    }
    commands.push({
      type: 'clean-strip-resolutions',
      phase: 0,
      cwd: dir,
      cmd: 'strip yalc resolutions for managed packages',
    });
  }
  return commands;
}

function cleanCommand(args) {
  if (args.fromStep != null && args.fromStep > 1) {
    fail('--from-step is only supported for apply and registry apply');
  }
  const ctx = loadConfig(args.config);
  const dirs = collectAllCleanDirectories(ctx, args.scope);
  section('Clean paths');
  for (const d of dirs) {
    info(d);
  }
  const commands = buildCleanCommands(ctx, dirs);
  printCommandList(commands, args);
  if (args.dryRun) {
    section('Done');
    info('Dry-run: no commands executed.');
    return;
  }
  executeCommands(commands, false, { ctx, args });
  section('Done');
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.command) {
    printHelp();
    process.exit(1);
  }

  switch (args.command) {
    case 'apply':
      applyCommand(args);
      break;
    case 'clean':
      cleanCommand(args);
      break;
    case 'registry-apply':
      registryApplyCommand(args);
      break;
    case 'registry-clean':
      registryCleanCommand(args);
      break;
    default:
      fail(`Unknown command: ${args.command}`);
  }
}

main();
