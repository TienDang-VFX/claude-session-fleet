#!/usr/bin/env bash
# Installs session-fleet for Claude Code on this macOS / Linux machine.
#   ./install.sh --marker MyGame.uproject                 (finds the project folder and names the machine by itself)
#   ./install.sh --machine macmini --root ~/work/mygame
#   ./install.sh --marker MyGame.uproject --registry-git ""   (registry: this machine only)
set -euo pipefail
machine=""; group=""; root=""; marker=""; registry=""
registry_git="https://github.com/TienDang-VFX/claude-session-registry.git"
while [ $# -gt 0 ]; do
  case "$1" in
    --machine) machine="$2"; shift 2 ;;
    --group) group="$2"; shift 2 ;;
    --root) root="$2"; shift 2 ;;
    --marker) marker="$2"; shift 2 ;;
    --registry-dir) registry="$2"; shift 2 ;;
    --registry-git) registry_git="$2"; shift 2 ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
done
here="$(cd "$(dirname "$0")" && pwd)"
claude_dir="$HOME/.claude"
mkdir -p "$claude_dir"

# Machine name: the short host name, lower case.
[ -n "$machine" ] || machine="$(hostname -s | tr '[:upper:]' '[:lower:]')"
echo "Machine name: $machine"

# Project folder: the folder holding $marker, up to three levels below home and two below each mounted volume.
if [ -z "$root" ]; then
  [ -n "$marker" ] || { echo "Pass --root <folder> or --marker <file that marks the project folder>" >&2; exit 2; }
  found="$( { find "$HOME" -maxdepth 4 -name "$marker" -not -path '*/Library/*' 2>/dev/null; \
              find /Volumes -maxdepth 3 -name "$marker" 2>/dev/null; } | xargs -I{} dirname {} | sort -u)"
  [ -n "$found" ] || { echo "No folder holding $marker found; pass --root." >&2; exit 1; }
  echo "Folders holding $marker:"; echo "$found" | sed 's/^/  /'
  root="$(for d in $found; do [ -d "$d/.git" ] && echo "$d"; done | head -1)"
  [ -n "$root" ] || root="$(echo "$found" | head -1)"
fi
echo "Project folder: $root"

if [ -n "$registry_git" ] && [ -z "$registry" ]; then registry="$claude_dir/session-fleet-registry"; fi
if [ -n "$registry_git" ]; then
  if command -v gh >/dev/null; then gh auth setup-git; fi
  [ -d "$registry/.git" ] || git clone "$registry_git" "$registry"
  git -C "$registry" config user.name "session-fleet $machine"
  git -C "$registry" config user.email "session-fleet@$machine.local"
fi

cat > "$claude_dir/session-fleet.json" <<EOF
{
  "machineName": "$machine",
  "sidebarGroup": "${group:-$machine}",
  "projectRoot": "$root",
  "registryDir": "$registry",
  "enforceFolder": true
}
EOF
echo "Wrote $claude_dir/session-fleet.json"

claude plugin marketplace add "$here"
claude plugin install session-fleet@session-fleet-local --scope user

cat <<EOF

Done. Two things left by hand on this machine:
  1. Claude desktop app: Settings > Claude Code > 'Connect new sessions to Remote Control' = On
  2. Terminal sessions: add  "remoteControlAtStartup": true  to $claude_dir/settings.json
Then open a new session: its title starts with [$machine].
EOF
