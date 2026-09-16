#!/bin/bash
set -e
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  if [ -x "$PWD/.tools/node/bin/node" ]; then
    export PATH="$PWD/.tools/node/bin:$PATH"
  else
    echo "Install Node.js 22.12 or later, then run this launcher again."
    read -r -p "Press Enter to close. "
    exit 1
  fi
fi
if [ ! -d node_modules ]; then
  npm ci
fi
echo "RailWitness is available at http://127.0.0.1:5173"
echo "Keep this terminal open while using the dashboard. Press Control-C to stop."
npm run dev -- --strictPort
