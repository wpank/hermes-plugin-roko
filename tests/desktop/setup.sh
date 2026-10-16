#!/usr/bin/env bash
# Link Hermes' own node_modules into tests/desktop/node_modules (gitignored), one
# symlink per package, so the vitest suite here runs desktop/plugin.js through
# the REAL Hermes desktop loader, SDK and React without installing anything.
# Nothing is written into the Hermes checkout: vite's caches land in this
# directory (node_modules/.vite-temp and .harness/).
#
#   HERMES_AGENT_SRC   the Hermes checkout (default: ~/.hermes/hermes-agent)
#
# Then:  <node> tests/desktop/node_modules/vitest/vitest.mjs run --config tests/desktop/vitest.config.mts
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
hermes="${HERMES_AGENT_SRC:-$HOME/.hermes/hermes-agent}"
hermes="${hermes/#\~/$HOME}"
src="$hermes/node_modules"
dest="$here/node_modules"

if [ ! -f "$hermes/apps/desktop/src/contrib/runtime-loader.ts" ]; then
  echo "setup.sh: no Hermes desktop sources at $hermes (set HERMES_AGENT_SRC)" >&2
  exit 2
fi

if [ ! -f "$src/vitest/vitest.mjs" ]; then
  echo "setup.sh: $src has no vitest; run 'npm install' in $hermes first" >&2
  exit 2
fi

mkdir -p "$dest" "$here/.harness"

# One readlink per package is slow on a busy machine (it timed out at 120 s once): skip the walk while
# Hermes' package list is the one the links were made for.
stamp="$here/.harness/links.stamp"
want="$src $(ls -1 "$src" | shasum | cut -d' ' -f1)"
if [ -f "$stamp" ] && [ "$(cat "$stamp")" = "$want" ] && [ -e "$dest/vitest/vitest.mjs" ]; then
  echo "tests/desktop/node_modules: links from $src are current"
  exit 0
fi

added=0

for entry in "$src"/*; do
  name="${entry##*/}"
  link="$dest/$name"

  if [ -L "$link" ]; then
    if [ "$(readlink "$link")" = "$entry" ]; then
      continue
    fi
    rm "$link"
  elif [ -e "$link" ]; then
    echo "setup.sh: $link exists and is not a symlink; leaving it alone" >&2
    continue
  fi

  ln -s "$entry" "$link"
  added=$((added + 1))
done

# Drop links to packages that left Hermes' node_modules.
for link in "$dest"/*; do
  if [ -L "$link" ] && [ ! -e "$link" ]; then
    rm "$link"
  fi
done

total="$(find "$dest" -mindepth 1 -maxdepth 1 -type l | wc -l | tr -d ' ')"
echo "tests/desktop/node_modules: $total packages linked from $src ($added new)"
echo "$want" > "$stamp"
