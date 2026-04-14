# local-registry-manager

CLI helpers for linking MetaMask monorepos with **yalc** or a local **Verdaccio** registry. Configuration lives in `local-registry.yml` beside this tool (repos, managed packages, consumers).

## Yalc workflow

```bash
yarn yalc apply --changed @scope/pkg-a,@scope/pkg-b --dry-run
```

Use `yarn yalc` so dependencies resolve under Yarn PnP.

## Verdaccio workflow (`registry apply`)

Publishes each selected package to a registry with deterministic **dev** prerelease versions (`x.y.z-dev.1`, `x.y.z-dev.2`, …), pins **cross-repo** managed dependencies to exact versions, runs `yarn`, build, then `npm publish` (or `yarn npm publish`). Consumer directories in `local-registry.yml` get matching semver pins and a final `yarn`.

**Prerequisites**

1. [Verdaccio](https://verdaccio.org/) running (default `http://localhost:4873`).
2. On every package you publish, set `publishConfig` so npm targets the local registry:

   ```json
   {
     "publishConfig": {
       "registry": "http://localhost:4873"
     }
   }
   ```

3. In each repo where you run `yarn` / `npm install` against Verdaccio, add a **repo-local** `.npmrc`:

   ```
   registry=http://localhost:4873
   ```

   Verdaccio proxies the public npm registry for packages you have not published locally.

4. **Yarn 4:** Resolution uses `npmRegistryServer`, not only `.npmrc`. During `registry apply`, each `yarn` runs with registry env vars pointing at `--registry`, and for **http://** URLs it also sets **`YARN_UNSAFE_HTTP_WHITELIST`** (comma-separated hostnames) so Yarn allows HTTP to local Verdaccio (fixes **YN0081** / “Unsafe http requests must be explicitly whitelisted”). For manual `yarn` in that repo, add to `.yarnrc.yml`: `unsafeHttpWhitelist: ["localhost", "127.0.0.1"]` (plus your registry host if it is not localhost), and `npmRegistryServer` as needed.

**CLI**

Prerelease versions (`x.y.z-dev.N`) require an npm **dist-tag** on publish. The tool passes `--tag` automatically (default: same as `--preid`, usually `dev`). Override with `--publish-tag` if needed.

Before each `npm publish`, the tool runs `npm view <name>@<version>` against your registry. If that exact version is **already published** (for example you re-ran the workflow without bumping), the publish step is **skipped** so Verdaccio does not return **E409 Conflict**. Use **`--force-registry-publish`** if you need to attempt a publish anyway (for example when the registry already has that version but you want to retry).

If **`npm publish` fails with E409** (duplicate version / “already present”), the tool **bumps** the package’s dev prerelease (`x.y.z-dev.N` → `N+1`), updates planned pins for later steps and any **`--sync-registry-resolutions`** merges already written, then **retries** publish (up to 50 attempts). You still avoid conflicts in the common case by not using `--force-registry-publish` and letting the preflight skip handle already-published versions.

```bash
yarn registry apply --changed @scope/pkg-a,@scope/pkg-b --dry-run
yarn registry apply --changed @scope/pkg-a --scope extension
yarn registry apply --changed @scope/pkg-a --registry http://localhost:4873 --preid dev
yarn registry apply --changed @scope/pkg-a --publish-tag dev
yarn registry apply --changed @scope/pkg-a --use-yarn-publish
# Resume after a failure (n matches the numbered lines under "Command list"):
yarn registry apply --changed @scope/pkg-a --from-step 14
```

Same `--from-step <n>` works for `yarn yalc apply` (yalc workflow).

**Deduping with Yarn `resolutions`**

Large monorepos often pull multiple semver-compatible copies of the same internal package, which can break TypeScript when types diverge. Pass **`--sync-registry-resolutions`** on `registry apply`: before the first **`yarn`** at each install root in **phase 2 and phase 3** (not phase 1), the tool merges **`resolutions`** into that repo’s **workspace root** `package.json` only. **Which package names get pinned** uses the same logic as **`--sync-yalc-resolutions`**: `getPublishSetNamesForYalcResolutions` (declared managed dependencies in resolution scope, transitive closure within the publish plan, exclude same-repo workspace packages). Stale keys for publish-plan names that would not be yalc-pinned here are removed. Phase 1 is the first publish wave (for example `accounts`); phase 2 is the next wave (for example `core`); phase 3 is **`consumers`** in `local-registry.yml`. Nested `packages/*` manifests are not edited. Restore with git when done, like other `package.json` edits.

Optional top-level key in `local-registry.yml`:

```yaml
registry: http://localhost:4873
```

CLI `--registry` overrides that value. The tool passes `--registry <url>` to `npm publish` / `yarn npm publish` as well.

**`registry clean`**

Does not edit files. Prints suggested `git checkout` paths and configured directories. Restore `package.json` manually (or with git) after local publishes (including merged `resolutions` if you used `--sync-registry-resolutions`).

**Why Verdaccio instead of yalc for some graphs**

When multiple repos and a consumer app all depend on the same internal packages, path-based yalc links can disagree. Publishing semver versions to one registry lets npm/yarn resolve a single version per package, including diamond dependencies.

**Scoped packages**

If `npm publish` rejects scoped packages, ensure `.npmrc` includes `access=public` for those scopes or use your registry’s access settings.

## Config

See `local-registry.yml` for `repos`, `packages` (`publishDir`, `build`, `dependsOn`), and `consumers`.

## Tests

```bash
yarn test
```
