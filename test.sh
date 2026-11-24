#!/bin/sh
# Runs webapp tests within the memory of a laptop. Plain jest starts a worker per CPU core and each
# takes 1-2 GB here, so a wide run fills RAM and freezes the machine.
# Usage: ./test.sh <test files or directories>, paths from the repo root or from src/webapp/channels.
set -e
cd "$(dirname "$0")"
[ $# -gt 0 ] || { echo "usage: ./test.sh <test files or directories>" >&2; exit 2; }
for arg in "$@"; do
    shift
    set -- "$@" "${arg#src/webapp/channels/}"
done
cd src/webapp/channels
# UTC: some upstream tests depend on the time zone.
exec env TZ=Etc/UTC LC_ALL=en_US.UTF-8 LANG=en_US.UTF-8 npx jest --maxWorkers=2 --workerIdleMemoryLimit=1G "$@"
