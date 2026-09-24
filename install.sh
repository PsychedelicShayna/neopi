#!/usr/bin/env bash
# Install packages/coding-agent/dist/npi (built by ./build.sh) and deploy the
# NeoPi extensions from this checkout.
#
# Environment:
#   NPI_DEST              install path (default ~/.local/bin/npi)
#   PI_CODING_AGENT_DIR   agent dir whose extensions/ receives the links (default: the active profile's)
set -euo pipefail

cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"

die() {
	printf 'install.sh: error: %s\n' "$*" >&2
	exit 1
}
say() { printf 'install.sh: %s\n' "$*"; }

command -v bun >/dev/null || die "bun is not on PATH"

binary=packages/coding-agent/dist/npi
dest=$(realpath -ms -- "${NPI_DEST:-$HOME/.local/bin/npi}")
version=$(bun -p 'require("./packages/coding-agent/package.json").version')

[[ -x $binary && -f $binary.source ]] || die "$binary is missing or was not built by ./build.sh; run ./build.sh"
source_id=$(
	git rev-parse HEAD
	git diff --no-ext-diff --no-textconv --no-color --binary HEAD | sha256sum | cut -d" " -f1
	git ls-files -z --others --exclude-standard | xargs -0 -r sha256sum | sha256sum | cut -d" " -f1
)
[[ $(<"$binary.source") == "$source_id" ]] || die "$binary was built from a different tree than this checkout; run ./build.sh"

# Stage next to the destination, prove the staged copy runs, then rename over
# the destination: atomic, and a running npi keeps its old inode instead of
# failing with ETXTBSY or reading a torn file. A broken build is never installed.
mkdir -p -- "$(dirname -- "$dest")"
staged=$(mktemp "$dest.new.XXXXXX")
trap 'rm -f -- "$staged"' EXIT
cp -- "$binary" "$staged"
chmod 755 -- "$staged"
smoke() {
	local reported
	reported=$("$1" --version) || die "$1 --version failed"
	[[ $reported == "npi/$version" ]] || die "$1 reports '$reported', expected npi/$version"
	"$1" --smoke-test >/dev/null || die "$1 --smoke-test failed"
}
smoke "$staged"
mv -f -- "$staged" "$dest"
say "installed $dest"

bun scripts/install-neopi-extensions.ts

smoke "$dest"
say "smoke test passed: $("$dest" --version)"

on_path=$(command -v npi || true)
if [[ -n $on_path && $(readlink -f -- "$on_path") != $(readlink -f -- "$dest") ]]; then
	say "warning: 'npi' on PATH is $on_path, not $dest"
fi
running=0
for exe in /proc/[0-9]*/exe; do
	if [[ $(readlink -- "$exe" 2>/dev/null) == "$dest (deleted)" ]]; then running=$((running + 1)); fi
done
if ((running > 0)); then
	say "note: $running running npi process(es) still use the previous binary until restarted"
fi
