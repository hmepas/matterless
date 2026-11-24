#!/usr/bin/env bash
# Starts the proxy: the patched webapp from dist/ on http://localhost:9005, forwarding to the real server.
# Settings come from ./session.env, see session.env.example.
set -euo pipefail
cd "$(dirname "$0")"
if [ -f session.env ]; then
    set -a
    # shellcheck disable=SC1091
    source session.env
    set +a
fi
# ALL-mode categories and channel order live here, so they survive a wiped app profile.
export MM_ALL_TEAMS_LAYOUT_FILE="${MM_ALL_TEAMS_LAYOUT_FILE:-$PWD/all-teams-layout.json}"
# Live session cookies updated on login, so restarts and reloads keep a fresh SSO session.
export MM_SESSION_FILE="${MM_SESSION_FILE:-$PWD/session.json}"
: "${MM_SERVICESETTINGS_SITEURL:?set MM_SERVICESETTINGS_SITEURL=https://your-mattermost-host}"
if [ -s "${NVM_DIR:-$HOME/.nvm}/nvm.sh" ]; then
    # shellcheck disable=SC1091
    source "${NVM_DIR:-$HOME/.nvm}/nvm.sh" && nvm use 24 >/dev/null 2>&1 || true
fi
export MM_SERVICESETTINGS_SITEURL
exec node proxy.mjs "$@"
