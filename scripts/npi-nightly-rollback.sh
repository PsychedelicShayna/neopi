#!/usr/bin/env bash
# Restore the previous local nightly; running sessions keep their current image.
set -eu

case "${1-}" in
  --version)
    printf '%s\n' 'npi-nightly-rollback (local rollback helper)'
    exit 0
    ;;
  -h|--help)
    printf '%s\n' 'Usage: npi-nightly-rollback' 'Restore the previous nightly binary. --help and --version never change files.'
    exit 0
    ;;
  '') ;;
  *)
    printf 'Unknown argument: %s\n' "$1" >&2
    exit 2
    ;;
esac
if (( $# != 0 )); then
  printf '%s\n' 'Rollback takes no arguments.' >&2
  exit 2
fi

dir="$HOME/.local/lib/npi-nightly"
[[ -e $dir/npi.previous ]] || { echo "No previous nightly binary at $dir/npi.previous"; exit 1; }
[[ $dir/npi.previous -ef $dir/npi ]] && { echo "npi.previous is the build you're already on; nothing to roll back to."; exit 1; }
ln -f "$dir/npi" "$dir/npi.rolled-back"
ln -f "$dir/npi.previous" "$dir/npi"
echo "npi-nightly now runs the previous build: $("$dir/npi" --version 2>/dev/null | head -1)"
echo "The build you rolled back from is kept at $dir/npi.rolled-back."
