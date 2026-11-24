#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "$0")"

case "${1:-}" in
  --help|-h)
    printf '%s\n' 'Usage: ./start-chatgpt-mcp.sh [--local]' \
      'Starts Desktop Commander over HTTPS with OAuth and Tailscale Funnel.' \
      '--local serves OAuth and MCP on loopback HTTP for development.'
    exit 0 ;;
  --local|'') ;;
  *) printf 'Unknown argument: %s\n' "$1" >&2; exit 2 ;;
esac

if ! command -v node >/dev/null || ! command -v npm >/dev/null; then
  if command -v mise >/dev/null; then
    mise_node=$(mise where node 2>/dev/null || true)
  elif [[ -x "$HOME/.local/bin/mise" ]]; then
    mise_node=$("$HOME/.local/bin/mise" where node 2>/dev/null || true)
  fi
  if [[ -n "${mise_node:-}" ]]; then
    export PATH="$mise_node/bin:$PATH"
  fi
fi

if ! command -v npm >/dev/null || ! node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 22 || (major === 22 && minor >= 12) ? 0 : 1)' 2>/dev/null; then
  printf '%s\n' 'Desktop Commander requires Node.js 22.12 or newer and npm.' >&2
  exit 1
fi

if [[ "${1:-}" != --local ]] && ! command -v tailscale >/dev/null; then
  printf '%s\n' 'Install Tailscale and connect it to your tailnet before starting Funnel.' >&2
  exit 1
fi

if [[ ! -f node_modules/.package-lock.json || package-lock.json -nt node_modules/.package-lock.json || ! -x node_modules/.bin/tsc ]]; then
  npm ci --include=dev --no-audit
else
  npm run build
fi

exec node scripts/chatgpt-mcp.mjs "$@"
