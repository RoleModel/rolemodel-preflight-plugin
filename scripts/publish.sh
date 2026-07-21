#!/usr/bin/env bash
# publish.sh — prepare the plugin for upload to Framer
# Usage: pnpm run publish  (or bash scripts/publish.sh)
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

echo "▶ Running tests…"
pnpm run test

echo "▶ Type checking…"
pnpm run typecheck

echo "▶ Lint check…"
pnpm run check

echo "▶ Building…"
pnpm run build

echo "▶ Copying screenshot to repo root…"
cp screenshots/preflight-panel.png ./preflight-panel.png

echo "▶ Zipping dist/ for Framer upload…"
ZIP_OUT="$REPO_ROOT/rolemodel-preflight.zip"
rm -f "$ZIP_OUT"
cd "$REPO_ROOT/dist"
zip -r "$ZIP_OUT" .
cd "$REPO_ROOT"

echo ""
echo "✅ Done!"
echo "   Screenshot : preflight-panel.png"
echo "   Plugin zip : rolemodel-preflight.zip"
echo ""
echo "Upload rolemodel-preflight.zip at:"
echo "  https://framer.com/developers/plugins → your plugin → Publish"
