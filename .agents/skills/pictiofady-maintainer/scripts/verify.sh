#!/usr/bin/env bash
set -euo pipefail

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 22+ est requis." >&2
  exit 1
fi

node_major="$(node -p 'Number(process.versions.node.split(".")[0])')"
if (( node_major < 22 )); then
  nvm_script="${NVM_DIR:-${HOME}/.nvm}/nvm.sh"
  if [[ ! -s "$nvm_script" ]]; then
    echo "Node.js 22+ est requis (version courante : $(node --version))." >&2
    exit 1
  fi
  # nvm is a shell function, so load it in this process before selecting Node 22.
  source "$nvm_script"
  nvm use 22 >/dev/null
fi

configured_xdg_dir="${XDG_CONFIG_HOME:-${HOME}/.config}"
if [[ ! -w "$configured_xdg_dir" ]]; then
  writable_xdg_dir="${TMPDIR:-/tmp}/pictiofady-xdg-config"
  mkdir -p "$writable_xdg_dir"
  export XDG_CONFIG_HOME="$writable_xdg_dir"
fi

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

scope="${1:-all}"
codex_home="${CODEX_HOME:-${HOME}/.codex}"
skill_validator="${codex_home}/skills/.system/skill-creator/scripts/quick_validate.py"

prepare_types() {
  npm run types >/dev/null
}

case "$scope" in
  client)
    prepare_types
    npx tsc --noEmit
    npx vitest run tests/session.test.ts tests/room-state.test.ts tests/drawing.test.ts tests/projection.test.ts
    ;;
  domain)
    npx vitest run tests/game.test.ts
    ;;
  server)
    prepare_types
    npx tsc --noEmit
    npx vitest run tests/game.test.ts tests/room.test.ts tests/rate-limit.test.ts
    ;;
  protocol)
    prepare_types
    npx tsc --noEmit
    npx vitest run tests/game.test.ts tests/room-state.test.ts tests/room.test.ts
    ;;
  docs)
    git diff --check HEAD
    if [[ -f "$skill_validator" ]]; then
      python3 "$skill_validator" .agents/skills/pictiofady-maintainer
    else
      echo "Validateur skill-creator absent; contrôle structurel ignoré." >&2
    fi
    ;;
  all)
    npm run check
    ;;
  *)
    echo "Usage: $0 {client|domain|server|protocol|docs|all}" >&2
    exit 2
    ;;
esac
