# Agent instructions

**Principle:** matterless is a local proxy in front of a remote Mattermost server that serves a patched upstream webapp built from `patches/`.

Read [README.md](./README.md) first for the project overview, features, architecture, and environment variables, then follow the rules and workflows below.

## Hard rules

1. **Never restart or kill a running proxy on port 9005.** The user may be using it live. Verify proxy changes on a separate port with `MM_PROXY_PORT=<free-port>` or via `node --test proxy.test.mjs`, which binds ephemeral ports.
2. **Never run plain `npx jest`, `--findRelatedTests`, or two heavy Node jobs at once.** Mattermost's webapp repo is large enough that parallel `jest`, `tsc`, or `webpack` runs freeze laptops. Always use `./test.sh <files-or-dirs>` and run `tsc`, `./test.sh`, and `./build.sh` strictly one at a time.
3. **Never touch or commit runtime secrets and build artifacts.** `session.env`, `session.json`, `all-teams-layout.json`, `proxy.log`, `dist/`, `dist.prev/`, and `src/` are local and gitignored. Never put real company domains, tokens, cookies, or private OAuth routes in tracked files or test fixtures. Use `https://chat.example` or `https://real.example` in tests.
4. **Never log message bodies, tokens, or cookies in `proxy.mjs`.** Every request-derived value written to `proxy.log` must pass through `logValue()` and contain ids or statuses only.

## Repository layout

| Path | Tracked | Role |
| --- | --- | --- |
| `proxy.mjs` | yes | Local HTTP and WebSocket proxy, Node stdlib only |
| `proxy.test.mjs` | yes | Black-box tests spawning real `proxy.mjs` against a fake upstream |
| `patches/BASE` | yes | Upstream Mattermost commit SHA the patches sit on |
| `patches/0001..*.patch` | yes | Numbered `git format-patch --zero-commit --no-signature` series, exported from `src` branch `public` |
| `patches.local/` | no | Private patches for one specific server, exported from `public..all-teams` |
| `run.sh`, `build.sh`, `update.sh`, `test.sh` | yes | Operational scripts |
| `session.env.example` | yes | Safe config template |
| `src/` | no | Local Mattermost checkout: branch `public` (shareable patches) and `all-teams` (`public` + private patches) |
| `dist/`, `dist.prev/` | no | Live production bundle and previous bundle for old hashed chunks |

## Bootstrapping a fresh workspace

If `src/` does not exist yet, initialize it from `patches/BASE` and apply the patch series:

```bash
BASE=$(cat patches/BASE)
git init src
git -C src remote add origin https://github.com/mattermost/mattermost.git
git -C src fetch --depth 1 --filter=blob:none origin "$BASE"
git -C src checkout -b all-teams FETCH_HEAD
git -C src am ../patches/*.patch
git -C src branch public
```

If you keep private patches in `patches.local/`, apply them on `all-teams` after that: `git -C src am ../patches.local/*.patch`.

Then install webapp dependencies using the Node version from `src/.nvmrc`:

```bash
cd src/webapp && npm ci --no-audit --no-fund --engine-strict=false
```

To produce `dist/` for the first time, run `./build.sh` from the repo root.

## Adding or editing a webapp feature

All webapp source edits live in `src/` and are persisted back to this repo as patches. `src/` has two layers:

- Branch `public`: `patches/BASE` plus everything shareable. Exported to the tracked `patches/`. This is the blueprint anyone can build from, so it must not contain anything specific to one company's server: no hostnames, no fork-only APIs or config flags, no features ported from a private server build.
- Branch `all-teams`: `public` plus private commits on top. This is what `dist/` is built from. The private commits are exported to the gitignored `patches.local/`.

1. **Check `src/` state first.** Confirm `git -C src status --short` is clean and `git -C src merge-base --is-ancestor public all-teams` succeeds. Decide which layer the change belongs to; if it touches both, split it into two commits.
2. **Keep patches modular and marked.** Add a brief `// PATCH(<topic>): ...` comment when modifying upstream files so future rebases in `update.sh` stay easy to resolve. Avoid editing unrelated upstream code.
3. **Follow Mattermost `release-10.10` constraints.** This branch uses React 17, `react-beautiful-dnd`, `react-custom-scrollbars`, and the local `utils/use_external_store.ts` shim instead of React 18's `useSyncExternalStore`. Keep new code compatible with `src/webapp/channels/tsconfig.json`.
4. **Write focused tests next to your changes.** Add or update Jest tests covering the feature and edge cases.
5. **Verify sequentially.** Run type-checking first, then targeted Jest tests, never both at once:
   ```bash
   (cd src/webapp/channels && ../node_modules/.bin/tsc --noEmit -p tsconfig.json)
   ./test.sh src/path/to/your_test.tsx
   ```
6. **Commit inside `src/` as one logical commit.** Give the commit a clear subject and body explaining why the change exists. That commit message becomes the patch file name and header.
   - Public change: save the old tip with `git -C src branch -f public-prev public`, commit on `public` (or cherry-pick onto it), then move the private layer on top with `git -C src rebase --onto public public-prev all-teams`.
   - Private change: commit on `all-teams` only.
7. **Build and export patches.** Run `./build.sh`. It builds `dist/` from `all-teams` atomically, keeps `dist.prev/` for open tabs, regenerates `patches/*.patch` from `$(cat patches/BASE)..public` and `patches.local/*.patch` from `public..all-teams`, and warns if the real server's host shows up in `patches/`.
8. **If you do not want to rebuild `dist/` yet**, you can export patches alone with:
   ```bash
   rm -f patches/*.patch
   git -C src format-patch -q --zero-commit --no-signature -o "$PWD/patches" "$(cat patches/BASE)..public"
   ```
9. **Commit in the outer repo.** Check `git diff --stat patches/` lists only the patches you meant to change, then stage `patches/` plus any outer files you changed and commit.

## Changing the proxy

`proxy.mjs` must stay zero-dependency ES module JavaScript using `node:*` built-ins only.

1. Keep security invariants intact:
   - Listen on `'localhost'` only.
   - Reject any request whose `Host` header is not `localhost:<port>`.
   - Reject cross-origin `POST`/`PUT` requests to `/__auth`, `/__auth/desktop`, `/__all_teams_layout`, `/__client_log`, and cross-origin WebSocket upgrades.
   - Validate any configured SSO path starts with `/` and not `//`.
   - Write `session.json` and `proxy.log` with mode `0600`.
2. Add or update black-box tests in `proxy.test.mjs`.
3. Run `node --test proxy.test.mjs`. All tests must pass.

## Changing how upstream SSO works

Do not hardcode company-specific OAuth routes in `proxy.mjs` or `src/`. `proxy.mjs` reads `MM_PROXY_SSO_PROVIDERS` in `Label=/path,Label2=/path2` format and forwards it to the webapp inside `/api/v4/config/client` as `ProxySsoProviders`. When unset, the webapp detects standard Mattermost OAuth and SAML flags from client config.

## Verification checklist before finishing

- `node --test proxy.test.mjs` passes.
- Targeted `./test.sh ...` suites pass for every touched webapp area.
- `tsc --noEmit -p tsconfig.json` passes in `src/webapp/channels` when TypeScript changed.
- `git diff` and `git status` contain zero real hostnames, tokens, cookies, or local runtime files.
- Live proxy on port 9005 was not restarted or disturbed.
