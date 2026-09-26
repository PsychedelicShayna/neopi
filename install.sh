#!/usr/bin/env bash
# Install packages/coding-agent/dist/npi (built by ./build.sh) and deploy the
# NeoPi extensions from this checkout.
#
# Environment:
#   NPI_DEST              install path; its file name must be npi (default ~/.local/bin/npi)
#   PI_CODING_AGENT_DIR   agent dir whose extensions/ receives the links (default: the active profile's).
#                         Setting it makes this a staged install: OMP_PROFILE and PI_PROFILE are
#                         ignored for the extension links, the smoke tests run under a throwaway
#                         HOME, and the live native cache is left alone.
set -euo pipefail

cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"

die() {
	printf 'install.sh: error: %s\n' "$*" >&2
	exit 1
}
say() { printf 'install.sh: %s\n' "$*"; }
# shellcheck source=scripts/npi-build-lib.sh
source scripts/npi-build-lib.sh

command -v bun >/dev/null || die "bun is not on PATH"

binary=packages/coding-agent/dist/npi
dest=$(realpath -ms -- "${NPI_DEST:-$HOME/.local/bin/npi}")
# The fork installs only as npi, and `npi update` routing keys on that basename.
[[ $(basename -- "$dest") == npi ]] || die "install path must be named npi, got $dest"
version=$(bun -p 'require("./packages/coding-agent/package.json").version')

[[ -x $binary && -f $binary.source ]] || die "$binary is missing or was not built by ./build.sh; run ./build.sh"
source_id=$(source_id)
binary_sha=$(sha256sum -- "$binary" | cut -d" " -f1)
[[ $(<"$binary.source") == "$source_id"$'\n'"$binary_sha" ]] ||
	die "$binary was not built by ./build.sh from this checkout as it is now; run ./build.sh"

# Stage next to the destination, prove the staged copy runs, then rename over
# the destination: atomic, and a running npi keeps its old inode instead of
# failing with ETXTBSY or reading a torn file. A broken build is never installed.
staging=0
[[ -n ${PI_CODING_AGENT_DIR:-} ]] && staging=1
smoke_home=""
mkdir -p -- "$(dirname -- "$dest")"
staged=$(mktemp "$dest.new.XXXXXX")
# The previous binary, kept (as a hard link to its inode) until the extensions deploy and the
# installed binary passes its smoke test; any failure after the rename puts it back.
previous=""
moved=0
installed=0
ext_touched=0
cleanup() {
	rm -f -- "$staged"
	[[ -z $smoke_home ]] || rm -rf -- "$smoke_home"
	((!ext_touched || installed)) || restore_extensions
	if [[ -n $previous ]]; then
		if ((installed)); then
			rm -f -- "$previous"
		else
			mv -f -- "$previous" "$dest" && say "restored the previous $dest"
		fi
	elif ((moved && !installed)); then
		# A first install that failed after the rename: no npi without its extensions.
		rm -f -- "$dest" && say "removed the incomplete $dest"
	fi
}
trap cleanup EXIT
if ((staging)); then
	# The smoke tests extract the native addon; keep that out of the live cache.
	smoke_home=$(mktemp -d)
fi
cp -- "$binary" "$staged"
chmod 755 -- "$staged"
run_isolated() {
	if ((staging)); then
		env -u PI_CONFIG_DIR -u XDG_CACHE_HOME -u XDG_DATA_HOME -u XDG_STATE_HOME HOME="$smoke_home" "$@"
	else
		"$@"
	fi
}
smoke() {
	local reported
	reported=$(run_isolated "$1" --version) || die "$1 --version failed"
	[[ $reported == "npi/$version" ]] || die "$1 reports '$reported', expected npi/$version"
	run_isolated "$1" --smoke-test >/dev/null || die "$1 --smoke-test failed"
}
smoke "$staged"
if [[ -e $dest ]]; then
	previous=$(mktemp -u "$dest.old.XXXXXX")
	ln -- "$dest" "$previous"
fi
mv -f -- "$staged" "$dest"
moved=1
say "installed $dest"

# A named profile would otherwise win over PI_CODING_AGENT_DIR in getAgentDir().
ext_env=()
((staging)) && ext_env=(env -u OMP_PROFILE -u PI_PROFILE)
ext_dir=$("${ext_env[@]}" bun -e 'import { defaultNeopiExtensionsDestDir } from "./scripts/install-neopi-extensions.ts"; process.stdout.write(defaultNeopiExtensionsDestDir())')
# The managed entries as they were, so a failed install puts them back with the binary.
ext_names=(omomp-persona omomp-loadout omomp-repl omomp-live-persona)
for source in extensions/*/; do ext_names+=("$(basename -- "$source")"); done
declare -A ext_before=()
for name in "${ext_names[@]}"; do
	entry="$ext_dir/$name"
	if [[ -L $entry ]]; then
		ext_before[$name]="link:$(readlink -- "$entry")"
	elif [[ -e $entry ]]; then
		ext_before[$name]=kept
	else
		ext_before[$name]=absent
	fi
done
restore_extensions() {
	local name entry before backup
	for name in "${ext_names[@]}"; do
		entry="$ext_dir/$name"
		before=${ext_before[$name]}
		case $before in
		link:*)
			rm -f -- "$entry"
			ln -s -- "${before#link:}" "$entry"
			;;
		absent)
			[[ ! -L $entry ]] || rm -f -- "$entry"
			;;
		kept)
			# A real directory the installer renamed aside to .<name>.pre-symlink.<time>.
			if [[ -L $entry ]]; then
				backup=$(find "$ext_dir" -maxdepth 1 -name ".$name.pre-symlink.*" | sort | tail -n 1)
				rm -f -- "$entry"
				[[ -z $backup ]] || mv -- "$backup" "$entry"
			fi
			;;
		esac
	done
	say "restored the previous extension links in $ext_dir"
}
ext_touched=1
"${ext_env[@]}" bun scripts/install-neopi-extensions.ts --dest "$ext_dir"

smoke "$dest"
installed=1
say "smoke test passed: $("$dest" --version)"

prune_natives() {
	natives_version=$(bun -p 'require("./packages/natives/package.json").version')
	# The loader's own resolver: it can differ from pi-utils' cache dir under XDG.
	natives_dir=$(bun -e 'import { getNativesDir } from "./packages/natives/native/loader-state.js"; process.stdout.write(getNativesDir())')
	keep=" "
	for addon in packages/natives/native/pi_natives.*.node; do
		[[ -f $addon ]] && keep+="$(sha256sum -- "$addon" | cut -c1-16) "
	done
	pruned=0
	shopt -s nullglob
	for extracted in "$natives_dir/$natives_version"/pi_natives.*.node; do
		hash=${extracted%.node}
		hash=${hash##*.}
		[[ $hash =~ ^[0-9a-f]{16}$ && $keep != *" $hash "* ]] || continue
		# Selected in the last ten minutes, or mapped by a running process: it may be in use.
		[[ -z $(find "$extracted" -mmin -10 2>/dev/null) ]] || continue
		! grep -qsF -- "$extracted" /proc/[0-9]*/maps || continue
		rm -f -- "$extracted" && pruned=$((pruned + 1))
	done
	shopt -u nullglob
	((pruned == 0)) || say "pruned $pruned native addon(s) extracted by other builds of $natives_version"
}

# Each build extracts its embedded addon to a content-addressed file, and the
# runtime never deletes another build's file because that build may be loading
# it. Prune them here instead, sparing any addon a process has mapped or selected
# in the last ten minutes (the loader refreshes the mtime of the file it picks);
# a pruned build re-extracts on its next start. A staged install leaves the live
# cache alone.
if ((staging)); then
	say "staged install: live native cache left untouched"
else
	prune_natives
fi

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
