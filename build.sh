#!/usr/bin/env bash
# Builds the patched webapp from src/ and swaps it into dist/. The previous build stays in dist.prev/,
# and a failed build leaves dist/ untouched. A running proxy picks up the new build on page reload.
set -euo pipefail
cd "$(dirname "$0")"

# src/ keeps two layers: branch `public` (BASE + shareable patches) and `all-teams` (public + private
# patches for one specific server on top). Without a `public` branch everything is public.
PUBLIC=all-teams
if git -C src show-ref -q --verify refs/heads/public; then
    PUBLIC=public
    git -C src merge-base --is-ancestor public all-teams \
        || { echo "all-teams is not based on public: rebase it with git -C src rebase public all-teams" >&2; exit 1; }
fi
if [ -s "${NVM_DIR:-$HOME/.nvm}/nvm.sh" ]; then
    # shellcheck disable=SC1091
    source "${NVM_DIR:-$HOME/.nvm}/nvm.sh" && nvm use "$(cat src/.nvmrc)" >/dev/null
fi

(cd src/webapp/channels && npm run build)

rm -rf dist.new
cp -R src/webapp/channels/dist dist.new
[ -f dist.new/root.html ] || { echo "build produced no root.html" >&2; exit 1; }

DIRTY=""
[ -z "$(git -C src status --porcelain)" ] || DIRTY="-dirty"
echo "webapp $(git -C src rev-parse --short HEAD)$DIRTY, built $(date '+%F %T')" > dist.new/BUILD

rm -rf dist.prev
[ ! -d dist ] || mv dist dist.prev
mv dist.new dist

# Keep the patch in this repo's history too, so a commit here pins the webapp it was used with.
# Only the public layer goes to the tracked patches/; the private one goes to the ignored patches.local/.
rm -f patches/*.patch patches.local/*.patch
git -C src format-patch -q --zero-commit --no-signature -o "$PWD/patches" "$(cat patches/BASE)..$PUBLIC"
if [ "$PUBLIC" = public ] && [ -n "$(git -C src rev-list public..all-teams)" ]; then
    mkdir -p patches.local
    git -C src format-patch -q --zero-commit --no-signature -o "$PWD/patches.local" public..all-teams
fi

# Guard: the real server's host must never reach the tracked patches.
if [ -f session.env ]; then
    HOST=$(grep '^MM_SERVICESETTINGS_SITEURL=' session.env | cut -d= -f2- | sed -E 's#^https?://##; s#[/:].*##')
    if [ -n "$HOST" ] && grep -qiF "$HOST" patches/*.patch; then
        echo "WARNING: patches/ mentions the real server's host; move that commit to the private layer" >&2
    fi
fi

cat dist/BUILD
