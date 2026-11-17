#!/usr/bin/env bash
# Starts the local factory for every local target: each targets/*.yml, which git ignores.
# It needs the tokens that local-factory.sh needs.
# A target added later runs only after ./local-factory.sh stop and this script again. Stop and status stay with local-factory.sh.
set -euo pipefail
cd "$(dirname "$0")"
files=$(git ls-files --others --ignored --exclude-standard -- 'targets/*.yml')
[ -n "$files" ] || { echo "no local target in targets/"; exit 1; }
# Targets with maxRuns: 1 first: their .factory.yml starts the preview on the fixed port 3910, and only the first target's slot 1 gets 3910.
first=$(grep -lx 'maxRuns: 1' $files || true)
FACTORY_TARGET=$(for f in $first $(grep -Lx 'maxRuns: 1' $files || true); do basename "$f" .yml; done | paste -sd' ' -) exec ./local-factory.sh start
