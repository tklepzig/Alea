#!/usr/bin/env bash
# Regenerates the PWA PNG icons from the committed SVG sources.
# Run this whenever the logo or its colours change.
#   - logo.svg          -> logo-192.png, logo-512.png            (purpose "any")
#   - logo-maskable.svg -> logo-192-maskable.png, …-512-…        (purpose "maskable")
# Requires rsvg-convert (librsvg).

set -euo pipefail

ASSETS_DIR="$(dirname "$0")/../assets"

if ! command -v rsvg-convert >/dev/null 2>&1; then
  echo "ERROR: rsvg-convert not found (install librsvg)" >&2
  exit 1
fi

render() {
  local source="$1"
  local output="$2"
  local size="$3"

  echo "Rendering ${output} (${size}x${size}) ..."
  rsvg-convert -w "$size" -h "$size" "${ASSETS_DIR}/${source}" -o "${ASSETS_DIR}/${output}"
}

render "logo.svg"          "logo-192.png"          192
render "logo.svg"          "logo-512.png"          512
render "logo-maskable.svg" "logo-192-maskable.png" 192
render "logo-maskable.svg" "logo-512-maskable.png" 512

echo "Done."
