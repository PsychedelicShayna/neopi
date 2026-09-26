# Shared by build.sh and install.sh; sourced, never run.

# Digest lines for untracked, non-ignored files under the given pathspecs (all when none).
# Symlinks are recorded by their target text, never followed: a dangling link or a link to a
# directory must not fail the build.
untracked_digest() {
	local path
	git ls-files -z --others --exclude-standard -- "$@" | while IFS= read -r -d '' path; do
		if [[ -L $path ]]; then
			printf 'link %s -> %s\n' "$path" "$(readlink -- "$path")"
		else
			printf '%s  %s\n' "$(sha256sum -- "$path" | cut -d' ' -f1)" "$path"
		fi
	done
}

# Identity of the checkout as it is now: commit, uncommitted diff, and untracked files.
source_id() {
	git rev-parse HEAD
	git diff --no-ext-diff --no-textconv --no-color --binary HEAD | sha256sum | cut -d' ' -f1
	untracked_digest | sha256sum | cut -d' ' -f1
}
