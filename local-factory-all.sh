#!/usr/bin/env bash
# Starts the local factory for every target in targets/ at this moment. It needs the tokens that local-factory.sh needs.
# A target added later runs only after ./local-factory.sh stop and this script again. Stop and status stay with local-factory.sh.
set -euo pipefail
cd "$(dirname "$0")"
targets=$(basename -s .yml targets/*.yml)
# core_app first: its .factory.yml starts the preview on the fixed port 3910, and only the first target's slot 1 gets 3910.
FACTORY_TARGET=$({ grep -x core_app <<< "$targets"; grep -vx core_app <<< "$targets"; } | paste -sd' ' -) exec ./local-factory.sh start
