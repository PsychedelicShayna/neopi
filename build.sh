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
#   NPI_CARGO_JOBS=N         Cargo parallelism (default 6); only a dedicated build host should raise it
set -euo pipefail

cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"

die() {
	printf 'build.sh: error: %s\n' "$*" >&2
	exit 1
}
say() { printf 'build.sh: %s\n' "$*"; }
# shellcheck source=scripts/npi-build-lib.sh
source scripts/npi-build-lib.sh

[[ $(uname -s) == Linux ]] || die "only Linux is supported; elsewhere see 'Install from source' in README.md"
command -v bun >/dev/null || die "bun is not on PATH"
[[ -d node_modules ]] || die "node_modules is missing; run 'bun install --frozen-lockfile' first"

# Fixed, not inherited: an ambient larger CARGO_BUILD_JOBS would starve the machine (AGENTS.md).
# A dedicated build host opts in explicitly through NPI_CARGO_JOBS.
cargo_jobs=${NPI_CARGO_JOBS:-6}
[[ $cargo_jobs =~ ^[1-9][0-9]*$ ]] || die "NPI_CARGO_JOBS must be a positive integer"
export CARGO_BUILD_JOBS=$cargo_jobs

native_dir=packages/natives/native
version=$(bun -p 'require("./packages/natives/package.json").version')

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
	# The native driver's child builds detect the variant on their own; pin them to this one.
	export OMP_NATIVE_X64_VARIANT=$variant
	addon_name="pi_natives.linux-x64-$variant.node"
	;;
aarch64) addon_name=pi_natives.linux-arm64.node ;;
*) die "unsupported architecture $(uname -m)" ;;
esac
addon="$native_dir/$addon_name"
stamp="$native_dir/.$addon_name.stamp"

# Current addons report the version through a post-link stamp, not the
# pre-upstream per-release __piNativesV* symbol.
has_release() {
	local reported
	# A loader failure can exit Bun before our JS runs, even with exit code 0.
	# Require the version output as evidence that the addon actually loaded.
	reported=$(bun -e 'process.stdout.write(String(require(process.argv[1]).__piNativesBuildVersion?.()))' \
		"$(realpath -- "$1")") && [[ $reported == "$version" ]]
}

# Everything the addon is compiled from, the scripts and configs that drive that
# build, and the settings that change its bytes.
native_inputs() {
	local paths=(
		crates Cargo.toml Cargo.lock rust-toolchain.toml .cargo
		package.json bun.lock packages/natives/package.json
		packages/natives/scripts/build-bindings.ts
		scripts/bazel-natives.ts scripts/host-detect.ts scripts/stamp-native-version.ts
		BUILD.bazel MODULE.bazel MODULE.bazel.lock .bazelrc .bazelversion bazel
	)
	printf '%s\n' "$version" "$addon_name" "${RUSTFLAGS:-}" "${CARGO_ENCODED_RUSTFLAGS:-}" \
		"${OMP_NATIVE_CARGO_PROFILE:-}" "${OMP_NATIVE_BUILD_BACKEND:-}" "${RUSTC_LINKER:-}" \
		"${OMP_NATIVE_FEATURES:-}" "${CFLAGS:-}" "${CXXFLAGS:-}" "${LDFLAGS:-}" "${PCRE2_SYS_STATIC:-}"
	# Cargo overrides can change the compiler, wrapper or generated code.
	# Target linkers also reach the embedded relay through crates/pi-natives/build.rs.
	# CARGO_BUILD_JOBS only changes parallelism, not the addon's bytes; keying on it would
	# miss the cache whenever the job count differs.
	env | grep -E '^(RUSTC(_WRAPPER|_WORKSPACE_WRAPPER)?|CARGO_PROFILE_[A-Z0-9_]+|CARGO_BUILD_[A-Z0-9_]+|CARGO_TARGET_[A-Z0-9_]+_LINKER)=' |
		grep -v '^CARGO_BUILD_JOBS=' | LC_ALL=C sort || true
	# A Bazel rc (scripts/bazel-natives.ts) can change flags and toolchains.
	printf 'bazelrc %s\n' "${OMP_BAZEL_RC:-}"
	if [[ -n ${OMP_BAZEL_RC:-} && -f $OMP_BAZEL_RC ]]; then
		sha256sum <"$OMP_BAZEL_RC" || return 1
	fi
	# Hash working-tree bytes, not HEAD plus a diff: committing identical inputs
	# must not change the key. Deleted tracked files have an explicit marker.
	git ls-files -z --cached --others --exclude-standard -- "${paths[@]}" |
		LC_ALL=C sort -zu | while IFS= read -r -d '' path; do
			printf '%s\0' "$path"
			if [[ -L $path ]]; then
				printf 'link %s\0' "$(readlink -- "$path")"
			elif [[ -f $path ]]; then
				sha256sum <"$path" || exit 1
			else
				printf 'missing\0'
			fi
		done
}

# Include host identity because system libraries and target-cpu=native can
# differ even between machines with the same rustc and architecture.
host_fingerprint=$(
	host_os=$(uname -sm) && host_id=$(cat /etc/machine-id) &&
		host_rust=$("${RUSTC:-${CARGO_BUILD_RUSTC:-rustc}}" -vV) && host_bun=$(bun --version) &&
		host_cc=$(cc --version) && host_ld=$(ld --version) && host_libc=$(ldd --version) &&
		printf '%s\n' "$host_os" "$addon_name" "$host_id" "$host_rust" "$host_bun" "$host_cc" "$host_ld" "$host_libc"
) || die "could not fingerprint the native build host"
input_key=$( { native_inputs || exit 1; printf '%s\n' "$host_fingerprint"; } | sha256sum | cut -d' ' -f1)

# Keep file identity AND content in the checkout stamp. A copied or manually
# rebuilt addon cannot seed the cache just because its version still matches.
expected_stamp() {
	printf '%s\n%s\n%s\n' "$input_key" "$(stat -c '%s %i %y %z' "$addon")" \
		"$(sha256sum <"$addon" | cut -d' ' -f1)"
}

cache_dir=${NPI_NATIVE_CACHE:-/mnt/alias/m2/agents/native-cache}
cache_started=$SECONDS
cache_status=hit
cache_stored=false
cache_enabled=false
if [[ $cache_dir != off ]]; then
	if mkdir -p -- "$cache_dir" && exec {cache_lock}>"$cache_dir/$input_key.lock" && flock "$cache_lock"; then
		cache_enabled=true
	else
		say "native cache unavailable; using the normal build path"
	fi
fi

# The caller holds the entry lock for both reads and publication. Metadata is
# published last, so an interrupted store can never look like a complete entry.
cache_valid() {
	local recorded_key recorded_hash
	[[ -f $cache_dir/$input_key.node && ! -L $cache_dir/$input_key.node &&
		-f $cache_dir/$input_key.meta && ! -L $cache_dir/$input_key.meta ]] || return 1
	{
		IFS= read -r recorded_key
		IFS= read -r recorded_hash
	} <"$cache_dir/$input_key.meta"
	[[ $recorded_key == "$input_key" && $recorded_hash == "$(sha256sum <"$cache_dir/$input_key.node" | cut -d' ' -f1)" ]]
}

cache_restore() {
	local temporary
	cache_valid || return 1
	mkdir -p -- "$native_dir" || return 1
	temporary=$(mktemp "$native_dir/.restore.XXXXXX.node") || return 1
	if cp -- "$cache_dir/$input_key.node" "$temporary" && has_release "$temporary" &&
		mv -f -- "$temporary" "$addon"; then
		expected_stamp >"$stamp" || return 1
		say "native addon restored from cache: $input_key"
	else
		rm -f -- "$temporary"
		return 1
	fi
}

cache_store() (
	local temporary
	temporary=$(mktemp -d "$cache_dir/.store.XXXXXX") || return 1
	trap 'rm -rf -- "$temporary"' EXIT
	cp -- "$addon" "$temporary/addon" || return 1
	{
		printf '%s\n%s\n' "$input_key" "$(sha256sum <"$temporary/addon" | cut -d' ' -f1)"
		printf 'commit %s\ntime %s\nhost\n%s\n' "$(git rev-parse HEAD)" "$(date -u +%FT%TZ)" "$host_fingerprint"
	} >"$temporary/metadata"
	mv -f -- "$temporary/addon" "$cache_dir/$input_key.node" || return 1
	mv -f -- "$temporary/metadata" "$cache_dir/$input_key.meta"
)

# Keep the eight most recently stored entries. Never evict an entry another
# build holds, and never unlink lock files: waiters must share the same inode.
cache_prune() (
	local count=0 candidate entry_lock
	exec {prune_lock}>"$cache_dir/.prune.lock"
	flock "$prune_lock"
	while read -r _ candidate; do
		((count+=1))
		((count > 8)) || continue
		candidate=${candidate%.meta}
		[[ $candidate =~ ^[0-9a-f]{64}$ && $candidate != "$input_key" ]] || continue
		(
			exec {entry_lock}>"$cache_dir/$candidate.lock"
			flock -n "$entry_lock" || exit 0
			rm -f -- "$cache_dir/$candidate.node" "$cache_dir/$candidate.meta"
		)
	done < <(find "$cache_dir" -maxdepth 1 -type f -name '*.meta' -printf '%T@ %f\n' | sort -rn)
)

record_native_phase() {
	$cache_enabled || return 0
	(
		flock 9
		printf '{"event":"%s","key":"%s","duration":%d,"stored":%s,"exit_code":%d}\n' \
			"$cache_status" "$input_key" "$((SECONDS-cache_started))" "$cache_stored" "$1" >&9
	) 9>>"$cache_dir/ledger.jsonl" || say "could not append native cache ledger"
}
# Record failed builds too, without letting a ledger error mask the build error.
trap 'record_native_phase "$?"' EXIT

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
elif ! has_release "$addon"; then
	reason="$addon does not report native version $version"
elif [[ ${NPI_FORCE_NATIVE:-} == 1 ]]; then
	reason="NPI_FORCE_NATIVE=1"
elif [[ ! -f $stamp ]] || [[ $(<"$stamp") != "$(expected_stamp)" ]]; then
	reason="$addon was not built by build.sh from the current native inputs"
fi

if [[ -n $reason ]] && $cache_enabled && [[ ${NPI_FORCE_NATIVE:-} != 1 ]]; then
	if cache_restore; then
		reason=""
	else
		cache_status=miss
		say "native cache miss or verification failed: $input_key; using the normal rebuild"
	fi
fi

if [[ -n $reason ]]; then
	cache_status=miss
	say "rebuilding the native addon: $reason"
	[[ -d target ]] || say "no cargo target/ in this checkout: this is a full native build (expect 10+ minutes)"
	rm -f -- "$stamp"
	bun --cwd=packages/natives run build
	[[ -f $addon && ! -L $addon ]] || die "native build finished but $addon was not produced"
	has_release "$addon" || die "freshly built $addon does not report native version $version"
	expected_stamp >"$stamp"
else
	say "native addon is current: $addon"
fi

if $cache_enabled; then
	if ! cache_valid || [[ $cache_status == miss ]]; then
		if cache_store; then
			cache_stored=true
			[[ $cache_status == miss ]] || cache_status=store
			say "native addon stored in cache: $input_key"
		else
			say "native cache store failed; keeping the local addon"
		fi
	fi
	record_native_phase 0
	trap - EXIT
	flock -u "$cache_lock"
	exec {cache_lock}>&-
	cache_prune || say "native cache eviction failed"
fi
trap - EXIT

# The deck refuses a native addon without a fingerprint record, and `bun install` or a clean
# deletes node_modules/.npi-deck. The addon was just built or verified current for this tree, so
# this is the one step that can attest to it. Non-fatal: the deck is optional for the binary.
if [[ -f deck/scripts/native-addon.ts ]]; then
	bun deck/scripts/native-addon.ts --built || say "could not record the native addon for the deck; the deck will start without a backend"
fi

# install.sh refuses a binary built from other sources than the checkout holds,
# so record the tree this build starts from; a failed build leaves no record.
binary=packages/coding-agent/dist/npi
rm -f -- "$binary.source"
source_id=$(source_id)

# Bytecode stays off: the pinned Bun canary has produced executables with invalid
# bytecode that still exit 0 at build time. Extensions deploy in install.sh, never
# as a side effect of building.
started=$(mktemp)
trap 'rm -f -- "$started"' EXIT
# A host build only: an inherited cross target would write dist/npi-<target> instead.
env -u CROSS_TARGET OMP_BUILD_BYTECODE=0 bun --cwd=packages/coding-agent run build

[[ $binary -nt $started ]] || die "$binary was not rewritten by this build"
git diff --quiet -- "$native_dir/embedded-addon.js" || die "$native_dir/embedded-addon.js was left modified"
reported=$("$binary" --version)
[[ $reported == "npi/$version" ]] || die "$binary reports '$reported', expected npi/$version"
# The marker authenticates these exact bytes, not just the tree: install.sh refuses a
# same-version binary copied over dist/npi afterwards.
printf '%s\n%s\n' "$source_id" "$(sha256sum -- "$binary" | cut -d' ' -f1)" >"$binary.source"
say "built $binary ($reported)"
