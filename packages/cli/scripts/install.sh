#!/usr/bin/env sh
# Install the `platform` CLI from a GitHub Release.
# @REPO@ and @VERSION@ are substituted by the release workflow.
set -eu

REPO="@REPO@"
VERSION="@VERSION@"
TAG="cli-v${VERSION}"
BASE_URL="https://github.com/${REPO}/releases/download/${TAG}"

# --- detect OS/arch -------------------------------------------------------
os="$(uname -s)"
arch="$(uname -m)"
case "${os}" in
  Linux) target_os="linux" ;;
  Darwin) target_os="darwin" ;;
  *) echo "Unsupported OS: ${os}" >&2; exit 1 ;;
esac
case "${arch}" in
  x86_64 | amd64) target_arch="x64" ;;
  arm64 | aarch64) target_arch="arm64" ;;
  *) echo "Unsupported architecture: ${arch}" >&2; exit 1 ;;
esac
artifact="platform-${target_os}-${target_arch}"

# --- pick an install dir ---------------------------------------------------
if [ -w /usr/local/bin ]; then
  bin_dir="/usr/local/bin"
else
  bin_dir="${HOME}/.local/bin"
  mkdir -p "${bin_dir}"
fi

tmp="$(mktemp -d)"
trap 'rm -rf "${tmp}"' EXIT

echo "Downloading ${artifact} (platform v${VERSION})…"
download() {
  if command -v curl > /dev/null 2>&1; then
    curl -fsSL -o "$1" "$2"
  elif command -v wget > /dev/null 2>&1; then
    wget -qO "$1" "$2"
  else
    echo "Need curl or wget to download" >&2; exit 1
  fi
}
download "${tmp}/${artifact}" "${BASE_URL}/${artifact}"

# --- verify checksum when sha256sum is available ---------------------------
if command -v sha256sum > /dev/null 2>&1; then
  download "${tmp}/${artifact}.sha256" "${BASE_URL}/${artifact}.sha256"
  (cd "${tmp}" && sha256sum -c "${artifact}.sha256")
fi

install -m 0755 "${tmp}/${artifact}" "${bin_dir}/platform"
echo "Installed platform to ${bin_dir}/platform"

case ":${PATH}:" in
  *":${bin_dir}:"*) ;;
  *) echo "NOTE: ${bin_dir} is not on your PATH; add it to run 'platform'." ;;
esac

"${bin_dir}/platform" --version || true
