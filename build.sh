#!/usr/bin/env bash
# Builds the patched webapp from src/ and swaps it into dist/. The previous build stays in dist.prev/,
# and a failed build leaves dist/ untouched. A running proxy picks up the new build on page reload.
set -euo pipefail
cd "$(dirname "$0")"
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
rm -f patches/*.patch
git -C src format-patch -q --zero-commit --no-signature -o "$PWD/patches" "$(cat patches/BASE)..all-teams"

cat dist/BUILD
