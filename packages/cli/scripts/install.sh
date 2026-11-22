#!/usr/bin/env sh
# Install the `platform` CLI from a GitHub Release.
# @REPO@ and @VERSION@ are substituted by the release workflow.
#
# The repo is private, so release-asset downloads need GitHub auth. This script
# uses the `gh` CLI (authenticated) to fetch assets — the reliable path for a
# private repo. Install gh and run `gh auth login` first if needed.
set -eu

REPO="@REPO@"
VERSION="@VERSION@"
TAG="cli-v${VERSION}"

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

if ! command -v gh > /dev/null 2>&1; then
  echo "The gh CLI is required to install platform (private repo)." >&2
  echo "Install it from https://cli.github.com and run 'gh auth login', then retry." >&2
  exit 1
fi

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
gh release download "${TAG}" --repo "${REPO}" \
  --pattern "${artifact}" --pattern "${artifact}.sha256" --dir "${tmp}" --clobber

# --- verify checksum when sha256sum is available ---------------------------
if command -v sha256sum > /dev/null 2>&1 && [ -f "${tmp}/${artifact}.sha256" ]; then
  (cd "${tmp}" && sha256sum -c "${artifact}.sha256")
fi

install -m 0755 "${tmp}/${artifact}" "${bin_dir}/platform"
echo "Installed platform to ${bin_dir}/platform"

case ":${PATH}:" in
  *":${bin_dir}:"*) ;;
  *) echo "NOTE: ${bin_dir} is not on your PATH; add it to run 'platform'." ;;
esac

"${bin_dir}/platform" --version || true
