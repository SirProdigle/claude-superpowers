#!/usr/bin/env bash
# Re-apply the claude-superpowers rebrand across all tracked files.
#
# This fork renames the upstream plugin and marketplace from
# "superpowers-extended-cc" to "claude-superpowers". That name appears in ~80
# places — namespaced skill references (plugin:skill), manifests, hooks and
# tests — so an upstream merge will reintroduce the old name in any file it
# touches.
#
# Workflow after pulling upstream:
#   git fetch upstream && git merge upstream/main
#   ./scripts/rebrand.sh
#   git commit -am "chore: re-apply rebrand after upstream merge"
#
# Idempotent: running it on an already-rebranded tree is a no-op.

set -euo pipefail

cd "$(dirname "$0")/.."

OLD_PLUGIN="superpowers-extended-cc"
NEW_PLUGIN="claude-superpowers"
OLD_MARKET="superpowers-extended-cc-marketplace"
NEW_MARKET="claude-superpowers"

files=$(git grep -l -e "$OLD_PLUGIN" -e "$OLD_MARKET" || true)

if [ -z "$files" ]; then
  echo "Nothing to rebrand — tree is clean."
  exit 0
fi

count=$(printf '%s\n' "$files" | wc -l)
echo "Rebranding $count file(s): $OLD_PLUGIN -> $NEW_PLUGIN"

# Longest match first so the marketplace suffix is not left dangling.
printf '%s\n' "$files" | xargs sed -i \
  -e "s/${OLD_MARKET}/${NEW_MARKET}/g" \
  -e "s/${OLD_PLUGIN}/${NEW_PLUGIN}/g"

echo "Done. Remaining references (should be none):"
git grep -c -e "$OLD_PLUGIN" -e "$OLD_MARKET" || echo "  none"
