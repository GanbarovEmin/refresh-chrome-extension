#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE_SVG="$ROOT_DIR/icons/icon_master.svg"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/refresh-icons.XXXXXX")"
SIZES=(16 32 48 128 256 512)

cleanup() {
  rm -rf "$TMP_DIR"
}

trap cleanup EXIT

if [[ ! -f "$SOURCE_SVG" ]]; then
  echo "Missing source SVG: $SOURCE_SVG" >&2
  exit 1
fi

for size in "${SIZES[@]}"; do
  render_dir="$TMP_DIR/$size"
  mkdir -p "$render_dir"

  qlmanage -t -s "$size" -o "$render_dir" "$SOURCE_SVG" >/dev/null 2>&1

  rendered="$render_dir/$(basename "$SOURCE_SVG").png"
  target="$ROOT_DIR/icons/icon_${size}.png"

  if [[ ! -f "$rendered" ]]; then
    echo "Failed to render icon_${size}.png" >&2
    exit 1
  fi

  mv "$rendered" "$target"

  width="$(sips -g pixelWidth "$target" 2>/dev/null | awk '/pixelWidth/ { print $2 }')"
  height="$(sips -g pixelHeight "$target" 2>/dev/null | awk '/pixelHeight/ { print $2 }')"

  if [[ "$width" != "$size" || "$height" != "$size" ]]; then
    echo "icon_${size}.png has ${width}x${height}, expected ${size}x${size}" >&2
    exit 1
  fi

  echo "Rendered icon_${size}.png (${size}x${size})"
done
