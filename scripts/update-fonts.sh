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

  # All requested weights must share ONE variable-font URL. If Google ever
  # serves per-weight static files instead (the response is UA-dependent),
  # grabbing the first would silently ship a single-weight file whose declared
  # weight range suppresses synthesis — every other weight renders wrong with
  # no error anywhere.
  local woff2_urls
  woff2_urls=$(
    curl -sf -A "$UA" "$css_url" \
      | awk '/\/\* latin \*\//,/}/' \
      | grep -o 'https://fonts.gstatic.com[^)]*\.woff2' \
      | sort -u
  )

  if [[ -z "$woff2_urls" ]]; then
    echo "ERROR: could not find any woff2 URL in ${css_url}" >&2
    exit 1
  fi
  if [[ $(wc -l <<<"$woff2_urls") -ne 1 ]]; then
    echo "ERROR: expected one variable-font URL, got:" >&2
    echo "$woff2_urls" >&2
    exit 1
  fi

  echo "Downloading ${output} ..."
  curl -sf -o "${FONTS_DIR}/${output}" "$woff2_urls"
}

fetch_latin "https://fonts.googleapis.com/css2?family=Open+Sans:wght@300;400;600&display=swap" "open-sans-latin.woff2"

echo "Done."
