#!/usr/bin/env bash
# Build packages/coding-agent/dist/npi from this checkout.
#
# The native addon (packages/natives/native/pi_natives.*.node) is gitignored,
# per-checkout build output. Every upstream version bump invalidates it, and a
# Rust change invalidates it without changing the version. This script rebuilds
# it when it is missing, lacks this version's sentinel, or was built from other
# native inputs than the checkout now holds; otherwise the build is fast.
#
# Environment:
#   OMP_NATIVE_X64_VARIANT   modern | baseline (default: modern iff the CPU has AVX2)
#   NPI_FORCE_NATIVE=1       rebuild the native addon unconditionally
set -euo pipefail

cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"

die() {
	printf 'build.sh: error: %s\n' "$*" >&2
	exit 1
}
say() { printf 'build.sh: %s\n' "$*"; }

[[ $(uname -s) == Linux ]] || die "only Linux is supported; elsewhere see 'Install from source' in README.md"
command -v bun >/dev/null || die "bun is not on PATH"
[[ -d node_modules ]] || die "node_modules is missing; run 'bun install --frozen-lockfile' first"

# Fixed, not a default: an inherited larger value would starve the machine (AGENTS.md).
export CARGO_BUILD_JOBS=6

native_dir=packages/natives/native
version=$(bun -p 'require("./packages/natives/package.json").version')
sentinel="__piNativesV${version//[^A-Za-z0-9]/_}"

# The addon must match the libc of the Bun that loads it; scripts/host-detect.ts
# reads the same ELF interpreter. There is no modern musl x64 addon.
musl=0
LC_ALL=C grep -aq '/ld-musl-' <(head -c 8192 -- "$(readlink -f -- "$(command -v bun)")") && musl=1

case $(uname -m) in
x86_64)
	variant=${OMP_NATIVE_X64_VARIANT:-}
	if ((musl)); then
		[[ -z $variant || $variant == baseline ]] || die "musl hosts build only the baseline x64 addon"
		variant=baseline
	elif [[ -z $variant ]]; then
		if grep -qiw avx2 /proc/cpuinfo; then variant=modern; else variant=baseline; fi
	fi
	[[ $variant == modern || $variant == baseline ]] || die "OMP_NATIVE_X64_VARIANT must be modern or baseline"
	addon_name="pi_natives.linux-x64-$variant.node"
	;;
aarch64) addon_name=pi_natives.linux-arm64.node ;;
*) die "unsupported architecture $(uname -m)" ;;
esac
addon="$native_dir/$addon_name"
stamp="$native_dir/.$addon_name.stamp"

# The addon exports a function named after the package version. Same rule as
# containsVersionSentinel in packages/natives/native/version-sentinel.js: the
# next byte must not extend the identifier (18_1_1 must not match 18_1_10).
has_sentinel() { LC_ALL=C grep -aqE "${sentinel}([^A-Za-z0-9_]|\$)" "$1"; }

# Everything the addon is compiled from, the scripts and configs that drive that
# build, and the settings that change its bytes.
native_inputs() {
	local paths=(
		crates Cargo.toml Cargo.lock rust-toolchain.toml .cargo
		build.sh packages/natives/package.json packages/natives/scripts
		scripts/bazel-natives.ts scripts/host-detect.ts
		BUILD.bazel MODULE.bazel MODULE.bazel.lock .bazelrc .bazelversion bazel
	)
	printf '%s\n' "$version" "$addon_name" "${RUSTFLAGS:-}" "${CARGO_ENCODED_RUSTFLAGS:-}" \
		"${OMP_NATIVE_CARGO_PROFILE:-}" "${OMP_NATIVE_BUILD_BACKEND:-}"
	git rev-parse "${paths[@]/#/HEAD:}"
	git diff --no-ext-diff --no-textconv --no-color --binary HEAD -- "${paths[@]}"
	git ls-files -z --others --exclude-standard -- "${paths[@]}" | xargs -0 -r sha256sum
}

# The stamp pins the inputs and the identity of the addon file they produced, so
# a copied, symlinked, or hand-rebuilt addon is never trusted.
expected_stamp() {
	printf '%s\n%s\n' "$(native_inputs | sha256sum | cut -d' ' -f1)" "$(stat -c '%s %i %Y' "$addon")"
}

# The binary build embeds every addon variant present; build.sh can vouch only
# for the host one. Anything else is stale output from another build.
shopt -s nullglob
for other in "$native_dir"/pi_natives.*.node; do
	[[ $other == "$addon" ]] && continue
	say "removing $other (build.sh embeds only $addon_name)"
	rm -f -- "$other"
done
shopt -u nullglob

reason=""
if [[ -L $addon ]]; then
	reason="$addon is a symlink into another checkout"
	rm -f -- "$addon"
elif [[ ! -f $addon ]]; then
	reason="$addon is missing"
elif ! has_sentinel "$addon"; then
	reason="$addon lacks the $version sentinel $sentinel"
elif [[ ${NPI_FORCE_NATIVE:-} == 1 ]]; then
	reason="NPI_FORCE_NATIVE=1"
elif [[ ! -f $stamp ]] || [[ $(<"$stamp") != "$(expected_stamp)" ]]; then
	reason="$addon was not built by build.sh from the current native inputs"
fi

if [[ -n $reason ]]; then
	say "rebuilding the native addon: $reason"
	[[ -d target ]] || say "no cargo target/ in this checkout: this is a full native build (expect 10+ minutes)"
	rm -f -- "$stamp"
	bun --cwd=packages/natives run build
	[[ -f $addon && ! -L $addon ]] || die "native build finished but $addon was not produced"
	has_sentinel "$addon" || die "freshly built $addon still lacks $sentinel"
	expected_stamp >"$stamp"
else
	say "native addon is current: $addon"
fi

# install.sh refuses a binary built from other sources than the checkout holds,
# so record the tree this build starts from; a failed build leaves no record.
binary=packages/coding-agent/dist/npi
rm -f -- "$binary.source"
source_id=$(
	git rev-parse HEAD
	git diff --no-ext-diff --no-textconv --no-color --binary HEAD | sha256sum | cut -d" " -f1
	git ls-files -z --others --exclude-standard | xargs -0 -r sha256sum | sha256sum | cut -d" " -f1
)

# Bytecode stays off: the pinned Bun canary has produced executables with invalid
# bytecode that still exit 0 at build time. Extensions deploy in install.sh, never
# as a side effect of building.
started=$(mktemp)
trap 'rm -f -- "$started"' EXIT
OMP_BUILD_BYTECODE=0 NPI_SKIP_EXTENSION_INSTALL=1 bun --cwd=packages/coding-agent run build

[[ $binary -nt $started ]] || die "$binary was not rewritten by this build"
git diff --quiet -- "$native_dir/embedded-addon.js" || die "$native_dir/embedded-addon.js was left modified"
reported=$("$binary" --version)
[[ $reported == "npi/$version" ]] || die "$binary reports '$reported', expected npi/$version"
# The marker authenticates these exact bytes, not just the tree: install.sh refuses a
# same-version binary copied over dist/npi afterwards.
printf '%s\n%s\n' "$source_id" "$(sha256sum -- "$binary" | cut -d' ' -f1)" >"$binary.source"
say "built $binary ($reported)"
