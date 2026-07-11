#!/usr/bin/env bash
# Re-downloads the self-hosted font file from Google Fonts.
# Run this whenever you want to pick up a new font version.
# Only the latin subset is needed — Trica's UI text (digits, a-c/A-C, ° · =)
# all falls within U+0000-00FF.

set -euo pipefail

FONTS_DIR="$(dirname "$0")/../assets/fonts"
UA="Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"

mkdir -p "$FONTS_DIR"

fetch_latin() {
  local css_url="$1"
  local output="$2"

  local woff2_url
  woff2_url=$(
    curl -s -A "$UA" "$css_url" \
      | awk '/\/\* latin \*\//,/}/' \
      | grep -o 'https://fonts.gstatic.com[^)]*\.woff2' \
      | head -1
  )

  if [[ -z "$woff2_url" ]]; then
    echo "ERROR: could not find latin URL in ${css_url}" >&2
    exit 1
  fi

  echo "Downloading ${output} ..."
  curl -s -o "${FONTS_DIR}/${output}" "$woff2_url"
}

fetch_latin "https://fonts.googleapis.com/css2?family=Open+Sans:wght@300;400;600&display=swap" "open-sans-latin.woff2"

echo "Done."
