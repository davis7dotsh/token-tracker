#!/bin/sh
set -eu

tag=${1:-}
output_dir=${2:-dist}
targets=${TOKEN_TRACKER_TARGETS:-"darwin_arm64 darwin_x86_64 linux_arm64 linux_x86_64"}

if ! printf '%s\n' "$tag" |
  grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z][0-9A-Za-z.-]*)?$'; then
  echo "usage: $0 vMAJOR.MINOR.PATCH [OUTPUT_DIR]" >&2
  exit 1
fi

project_version=$(
  sed -n 's/^[[:space:]]*version: "\([^"]*\)",[[:space:]]*$/\1/p' mix.exs
)
if [ "$tag" != "v$project_version" ]; then
  echo "tag $tag does not match mix.exs version $project_version" >&2
  exit 1
fi

mkdir -p "$output_dir"

for target in $targets; do
  case "$target" in
    darwin_arm64|darwin_x86_64|linux_arm64|linux_x86_64) ;;
    *)
      echo "unsupported release target: $target" >&2
      exit 1
      ;;
  esac

  echo "Building $target"
  BURRITO_TARGET="$target" MIX_ENV=prod \
    mix release token_tracker_portable --overwrite

  binary="burrito_out/token_tracker_portable_${target}"
  if [ ! -f "$binary" ]; then
    echo "expected Burrito output was not created: $binary" >&2
    exit 1
  fi

  staging=$(mktemp -d)
  cp "$binary" "$staging/token-tracker"
  chmod 0755 "$staging/token-tracker"

  archive="$output_dir/token-tracker_${tag}_${target}.tar.gz"
  tar -czf "$archive" -C "$staging" token-tracker
  rm -rf "$staging"
done

(
  cd "$output_dir"
  : > checksums.txt
  for archive in token-tracker_"$tag"_*.tar.gz; do
    if command -v sha256sum >/dev/null 2>&1; then
      sha256sum "$archive" >> checksums.txt
    else
      shasum -a 256 "$archive" >> checksums.txt
    fi
  done
)
