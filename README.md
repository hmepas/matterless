# matterless

Run your own patched Mattermost webapp locally in front of any remote Mattermost server. You keep the server's data, auth, and plugins untouched, and load your UI patches in a browser or in Mattermost Desktop at `http://localhost:9005`.

## What the patch series adds

The webapp patches in `patches/` apply on top of upstream Mattermost `release-10.10`.

- **ALL pseudo-team sidebar.** A tile at the top of the team rail puts channels from every team, DMs, and GMs into one list with mini team badges. You can create custom categories, drag channels across teams, sort by unread or by team, and keep unread channels visible inside collapsed categories. The layout syncs to `all-teams-layout.json` on disk so it survives a wiped browser or Electron profile.
- **Latest messages panel.** A clock button in the channel header opens the 60 most recent messages in the channel in one chronological list, root posts and thread replies together, newest first.
- **Real server links behind the proxy.** Copied permalinks, forwarded posts, file links, invite URLs, and webhooks use the real server address instead of `http://localhost:9005`. Clicking a real server link in chat or bookmarks opens inside the local app.
- **Visible failed sends.** Upstream silently removes a post on some send errors. The patch keeps every failed send visible with a red error icon and reports failures to the local proxy log.
- **Independent SSO login.** The login screen and `/__auth` exchange a Mattermost `desktop_token` with the real server so the proxy holds its own session. You do not need a second server tab open in Mattermost Desktop.
- **Crash and chunk recovery.** A root error boundary catches render crashes and stale lazy-chunk errors after a rebuild, offers recovery without a blank screen, and retries transient permalink load failures.

## How it works

```
Mattermost Desktop or browser
        |
        v  http://localhost:9005
    proxy.mjs  (Node stdlib only, zero npm dependencies)
        |-- /static/* and HTML pages  -->  dist/  (falls back to dist.prev/ for old hashed chunks)
        |-- /__all_teams_layout       -->  all-teams-layout.json
        |-- /__auth, /__auth/desktop  -->  SSO desktop_token exchange and cookie helper
        |-- /__client_log             -->  proxy.log  (ids and statuses only, mode 0600)
        |-- /api/*, /plugins/*, /oauth/*, WebSocket  -->  real Mattermost server
```

Two details make Mattermost Desktop accept the local proxy without bouncing back to the real host.

1. On `/api/v4/config/client`, `proxy.mjs` copies the real `SiteURL` into `ProxyUpstreamSiteURL` and rewrites `SiteURL` and `WebsocketURL` to `http://localhost:9005` and `ws://localhost:9005`.
2. Before serving `root.html`, `proxy.mjs` probes `/api/v4/system/ping` on the upstream server. If the server or VPN is down, the proxy returns an auto-retrying `502` page instead of booting the webapp with an empty config and wiping the session.

The proxy binds to `localhost` only, rejects requests with a foreign `Host` header, and rejects cross-origin writes and WebSocket upgrades.

## Quick start

Requirements: Git, Node.js matching `src/.nvmrc` for building the webapp, and Node.js 20+ for running `proxy.mjs`.

### 1. Clone and apply the webapp patches

This repo tracks only the proxy, scripts, and `patches/`. Fetch the pinned Mattermost commit into `src/` and apply the patch series:

```bash
BASE=$(cat patches/BASE)
git init src
git -C src remote add origin https://github.com/mattermost/mattermost.git
git -C src fetch --depth 1 --filter=blob:none origin "$BASE"
git -C src checkout -b all-teams FETCH_HEAD
git -C src am ../patches/*.patch
```

Install webapp dependencies and build `dist/`:

```bash
cd src/webapp && npm ci --no-audit --no-fund --engine-strict=false
cd ../..
./build.sh
```

`build.sh` compiles the bundle into `dist.new/`, checks that `root.html` exists, moves the old build to `dist.prev/`, and swaps `dist.new/` into `dist/`. A failed build never touches the live `dist/`.

### 2. Configure the upstream server

```bash
cp session.env.example session.env
chmod 600 session.env
```

Set `MM_SERVICESETTINGS_SITEURL` in `session.env` to your Mattermost server URL:

```sh
MM_SERVICESETTINGS_SITEURL=https://mattermost.example.com
```

### 3. Start the proxy and sign in

```bash
./run.sh
```

Open `http://localhost:9005` in a browser or add it as a server in Mattermost Desktop.

**Email, username, or LDAP login.** Sign in directly on `/login`. The proxy strips `Domain` and `Secure` from `Set-Cookie` for localhost and saves the active session in `session.json` with mode `0600`.

**SSO login.** Standard OAuth and SAML providers enabled on your server appear automatically on `/login`. Click the SSO button to authenticate on the real server in your browser, then paste the final `/login/desktop?server_token=...` URL back into the form. You can also visit `http://localhost:9005/__auth` for a one-click browser bookmarklet or manual cookie paste.

**Custom SSO routes.** If your server uses non-standard OAuth paths or you want custom button labels, set `MM_PROXY_SSO_PROVIDERS` in `session.env`:

```sh
MM_PROXY_SSO_PROVIDERS="Corporate SSO=/oauth/openid/login,GitLab=/oauth/gitlab/login"
```

## Configuration

All runtime settings can go in `session.env` or in the process environment.

| Variable | Default | Purpose |
| --- | --- | --- |
| `MM_SERVICESETTINGS_SITEURL` | required | Upstream Mattermost origin, for example `https://mattermost.example.com` |
| `MM_PROXY_PORT` | `9005` | Localhost port for `proxy.mjs` |
| `MM_PROXY_SSO_PROVIDERS` | unset | Comma-separated `Label=/oauth/path` buttons for `/login` and `/__auth` |
| `MM_DIST_DIR` | `./dist` | Built webapp directory |
| `MM_ALL_TEAMS_LAYOUT_FILE` | `./all-teams-layout.json` | Persisted ALL-mode categories and channel order |
| `MM_SESSION_FILE` | `./session.json` | Persisted session cookies updated on login and cleared on logout or 401 |
| `MM_PROXY_LOG` | `./proxy.log` | Audit log for sends, errors, and WebSocket drops, rotated at 10 MB |
| `MM_PROXY_POST_TIMEOUT_MS` | `30000` | Timeout for `POST /api/v4/posts` before returning `504` |
| `MM_PROXY_PING_TIMEOUT_MS` | `5000` | Timeout for upstream reachability check before serving HTML |
| `MM_SESSION_TOKEN`, `MM_SESSION_USERID`, `MM_SESSION_CSRF` | empty | Optional manual cookie seed if you do not use `/login` or `/__auth` |

## Updating Mattermost

`update.sh` fetches the latest commit of `UPSTREAM_BRANCH`, rebases `all-teams` onto it, runs `npm ci`, type-checks with `tsc`, runs the patch tests, updates `patches/BASE`, and rebuilds `dist/`:

```bash
./update.sh
```

If your Mattermost server upgrades to a newer release branch, edit `UPSTREAM_BRANCH` in `update.sh` before running it. On a rebase conflict, `update.sh` aborts cleanly and leaves `dist/` untouched.

## Tests

Run proxy tests with Node's built-in test runner:

```bash
node --test proxy.test.mjs
```

Run webapp tests through `test.sh`, never plain `npx jest`. Plain Jest spawns a worker per CPU core and can exhaust laptop RAM on Mattermost's monorepo.

```bash
./test.sh src/utils/all_teams_mode src/components/post_send_status src/components/login/proxy_sso_login.test.tsx
```

## Repo map

- `proxy.mjs` and `proxy.test.mjs`: standalone HTTP and WebSocket proxy with black-box tests.
- `patches/`: numbered `git format-patch` series plus `patches/BASE`.
- `build.sh`: builds `src/webapp/channels`, swaps `dist/`, and re-exports `patches/*.patch`.
- `run.sh`: loads `session.env` and starts `proxy.mjs`.
- `update.sh`: rebases `src/` onto upstream, verifies, and rebuilds.
- `test.sh`: memory-capped Jest wrapper running with `--maxWorkers=2` and `1G` idle worker limit.
- Ignored local runtime files: `src/`, `dist/`, `dist.prev/`, `session.env`, `session.json`, `all-teams-layout.json`, `proxy.log`.
