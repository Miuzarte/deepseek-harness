#!/usr/bin/env bash
# Build the Web GUI on a Linux server: install, build every artifact, restart.
#
# The desktop app is not involved; this is the source deployment that
# `pnpm dsh web` serves. Cross-version syncs need the full build because the
# browser side is all build output (client bundles plus the Web frontend dist).

set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: ./build-server.sh [options]

  --sync              git fetch origin, then reset --hard origin/master
  --no-install        skip pnpm install --frozen-lockfile
  --restart <unit>    after the build, run: sudo systemctl restart <unit>
  --dry-run           print the resolved commands without running them
  -h, --help          show this help

Environment:
  HTTPS_PROXY / HTTP_PROXY   passed through to the build when set
USAGE
}

sync=0
install=1
dry_run=0
restart_unit=""

while [ $# -gt 0 ]; do
  case "$1" in
    --sync) sync=1 ;;
    --no-install) install=0 ;;
    --restart)
      shift
      restart_unit="${1:-}"
      if [ -z "$restart_unit" ]; then
        echo "build-server: --restart needs a systemd unit name" >&2
        exit 2
      fi
      ;;
    --dry-run) dry_run=1 ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "build-server: unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
  shift
done

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$repo_root"

run() {
  printf '+ %s\n' "$*"
  if [ "$dry_run" -eq 1 ]; then
    return 0
  fi
  "$@"
}

command -v node >/dev/null 2>&1 || {
  echo "build-server: node is not on PATH; install Node.js >= 24.9" >&2
  exit 1
}
command -v pnpm >/dev/null 2>&1 || {
  echo "build-server: pnpm is not on PATH; install pnpm 11.28.5 (corepack enable)" >&2
  exit 1
}

if ! node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 24 || (major === 24 && minor >= 9) ? 0 : 1)'; then
  echo "build-server: node $(node --version) is older than the required 24.9.0" >&2
  exit 1
fi

echo "repo:  $repo_root"
echo "node:  $(node --version)"
echo "pnpm:  $(pnpm --version)"

started=$(date +%s)

if [ "$sync" -eq 1 ]; then
  # This branch is force-pushed by the sync job, so pull would build a merge.
  run git fetch origin
  run git reset --hard origin/master
fi

if [ "$install" -eq 1 ]; then
  # CI=true keeps a lockfile change from aborting on a missing TTY.
  run env CI=true pnpm install --frozen-lockfile
fi

run pnpm run build

if [ -n "$restart_unit" ]; then
  run sudo systemctl restart "$restart_unit"
  run sudo systemctl is-active --quiet "$restart_unit"
else
  echo
  echo "restart the Web GUI yourself, for example:"
  echo "  sudo systemctl restart <unit>"
  echo "  pnpm dsh web --host 0.0.0.0 --allow-lan --port 3080 --no-open"
fi

echo "done in $(( $(date +%s) - started ))s"
