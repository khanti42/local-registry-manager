#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { execSync } from 'node:child_process';
import yaml from 'js-yaml';
import semver from 'semver';

const DEFAULT_CONFIG = 'yalc.yml';

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
Usage:
  node yalc-manager.js apply --changed <pkg1,pkg2,...> [options]

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
  --config <path>        Config file path. Default: yalc.yml
  --help                 Show help.

  Consumer YAML (per group under consumers.<name>):
    installDir: <path>   Optional, relative to that group's repo root. When set, yarn runs there;
                         yalc update/add still run in each dir under dirs. Example: installDir: .

Examples:
  node yalc-manager.js apply \\
    --changed @metamask/utils,@metamask/keyring-api \\
    --dry-run

  node yalc-manager.js apply \\
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
    config: DEFAULT_CONFIG,
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
    if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
    if (arg.startsWith('--')) {
      fail(`Unknown option: ${arg}`);
    }
    positional.push(arg);
  }

  args.command = positional[0] ?? null;
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
 * @param {string} cmd
 * @param {string} cwd
 * @param {{ dryRun?: boolean, shell?: boolean }} [options]
 */
function run(cmd, cwd, { dryRun = false, shell = false } = {}) {
  console.log(`\n$ ${cmd}`);
  console.log(`  cwd: ${cwd}`);

  if (dryRun) {
    console.log('  skipped (dry-run)');
    return { ok: true, code: 0 };
  }

  try {
    execSync(cmd, { cwd, stdio: 'inherit', shell });
    return { ok: true, code: 0 };
  } catch (error) {
    return { ok: false, code: typeof error.status === 'number' ? error.status : 1 };
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
 * @returns {{ type: string, phase: number, cwd: string, cmd: string, shell?: boolean }[]}
 */
function planManagedPackageCommands(
  ctx,
  pkgName,
  phase,
  publishSet,
  fullOrder,
  fullOrderIndex,
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
 * @param {{ stage: boolean }} options
 * @returns {{ type: string, phase: number, cwd: string, cmd: string, shell?: boolean }[]}
 */
function planLinkCommands(ctx, consumer, impacts, options) {
  if (!impacts.length) {
    return [];
  }

  const consumerRepoKey = ctx.config.consumers[consumer.group]?.repo;
  const { absoluteDir, installCwd } = consumer;
  const { stage } = options;
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

function shellQuotePath(p) {
  const s = String(p);
  if (/^[a-zA-Z0-9/_.:@+-]+$/.test(s)) {
    return s;
  }
  return `'${s.replace(/'/g, `'\\''`)}'`;
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
    info(`${i + 1}. [phase ${phase}] ${c.cwd} :: ${c.cmd}`);
  }

  if (args.showShellPreview) {
    subSection('Shell-friendly preview');
    for (const c of commands) {
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
 * @param {{ type: string, cwd: string, cmd: string, shell?: boolean }[]} commands
 * @param {boolean} dryRun
 */
function executeCommands(commands, dryRun) {
  for (const c of commands) {
    const res = run(c.cmd, c.cwd, { dryRun, shell: c.shell === true });
    if (!res.ok) {
      fail(`Command failed [${c.type}]: ${c.cmd}`);
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
      }),
    );
  }

  return commands;
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

  const commands = buildCommandPlan(
    ctx,
    plan,
    phase1Packages,
    phase2Packages,
    impactReports,
    args,
  );
  printCommandList(commands, args);

  if (args.dryRun) {
    section('Done');
    info('Dry-run: no commands executed.');
    return;
  }

  executeCommands(commands, false);

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
    default:
      fail(`Unknown command: ${args.command}`);
  }
}

main();
