#!/usr/bin/env bash
# Moves the patch onto the latest commit of the upstream release branch that matches our server,
# checks it and builds it. The running proxy only
# uses dist/, which changes in the very last step, so a failure anywhere here doesn't affect it.
set -euo pipefail
cd "$(dirname "$0")"
# The upstream branch matching the real server's version. Change it when the server is upgraded.
UPSTREAM_BRANCH=release-10.10
HAS_NVM=0
if [ -s "${NVM_DIR:-$HOME/.nvm}/nvm.sh" ]; then
    # shellcheck disable=SC1091
    source "${NVM_DIR:-$HOME/.nvm}/nvm.sh"
    HAS_NVM=1
fi

[ -z "$(git -C src status --porcelain)" ] || { echo "src has uncommitted changes" >&2; exit 1; }
[ "$(git -C src branch --show-current)" = all-teams ] || { echo "src is not on all-teams" >&2; exit 1; }

OLD_BASE=$(cat patches/BASE)
git -C src fetch -q --depth 1 --filter=blob:none origin "$UPSTREAM_BRANCH"
NEW_BASE=$(git -C src rev-parse FETCH_HEAD)
[ "$NEW_BASE" != "$OLD_BASE" ] || { echo "already on the latest $UPSTREAM_BRANCH"; exit 0; }

git -C src branch -f pre-update all-teams
if ! git -C src rebase --onto "$NEW_BASE" "$OLD_BASE" all-teams; then
    git -C src rebase --abort
    echo "the patch conflicts with $UPSTREAM_BRANCH: nothing changed, resolve it by hand" >&2
    exit 1
fi

undo_hint() {
    echo "update failed, dist/ is untouched. To undo: git -C src reset --hard pre-update, then npm ci in src/webapp" >&2
}
trap undo_hint ERR

if [ "$HAS_NVM" -eq 1 ]; then
    nvm use "$(cat src/.nvmrc)" >/dev/null
fi
(cd src/webapp && npm ci --no-audit --no-fund --engine-strict=false)
(cd src/webapp/channels && ../node_modules/.bin/tsc --noEmit -p tsconfig.json)
./test.sh src/utils/all_teams_mode src/selectors/views/all_teams src/components/sidebar/all_teams_list src/components/team_sidebar

echo "$NEW_BASE" > patches/BASE
./build.sh
trap - ERR
echo "built on $UPSTREAM_BRANCH ${NEW_BASE:0:7}. Reload the app; commit patches/ here if it works"
