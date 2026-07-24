#!/bin/sh
set -eu

repository=${TOKEN_TRACKER_REPOSITORY:-davis7dotsh/token-tracker}
install_dir=${TOKEN_TRACKER_INSTALL_DIR:-"$HOME/.local/bin"}
download_base=${TOKEN_TRACKER_DOWNLOAD_BASE:-"https://github.com/$repository/releases/download"}
version=${TOKEN_TRACKER_VERSION:-}

if [ -z "$version" ]; then
  latest_url=$(curl -fsSL -o /dev/null -w '%{url_effective}' \
    "https://github.com/$repository/releases/latest")
  version=${latest_url##*/}
fi

if ! printf '%s\n' "$version" |
  grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z][0-9A-Za-z.-]*)?$'; then
  echo "could not resolve a valid release version" >&2
  exit 1
fi

case "$(uname -s)" in
  Darwin) operating_system=darwin ;;
  Linux) operating_system=linux ;;
  *)
    echo "token-tracker supports macOS and Linux" >&2
    exit 1
    ;;
esac

case "$(uname -m)" in
  arm64|aarch64) architecture=arm64 ;;
  x86_64|amd64) architecture=x86_64 ;;
  *)
    echo "token-tracker supports arm64 and x86_64" >&2
    exit 1
    ;;
esac

asset="token-tracker_${version}_${operating_system}_${architecture}.tar.gz"
temporary=$(mktemp -d)
trap 'rm -rf "$temporary"' EXIT HUP INT TERM

curl -fsSL "$download_base/$version/$asset" -o "$temporary/$asset"
curl -fsSL "$download_base/$version/checksums.txt" -o "$temporary/checksums.txt"

expected=$(awk -v asset="$asset" '$2 == asset { print $1 }' "$temporary/checksums.txt")
if [ -z "$expected" ]; then
  echo "release checksum is missing for $asset" >&2
  exit 1
fi

if command -v sha256sum >/dev/null 2>&1; then
  actual=$(sha256sum "$temporary/$asset" | awk '{ print $1 }')
else
  actual=$(shasum -a 256 "$temporary/$asset" | awk '{ print $1 }')
fi

if [ "$actual" != "$expected" ]; then
  echo "checksum verification failed for $asset" >&2
  exit 1
fi

tar -xzf "$temporary/$asset" -C "$temporary"
mkdir -p "$install_dir"
install -m 0755 "$temporary/token-tracker" "$install_dir/token-tracker"

echo "Installed token-tracker $version at $install_dir/token-tracker"
case ":$PATH:" in
  *":$install_dir:"*) ;;
  *) echo "Add $install_dir to PATH to run token-tracker." ;;
esac
