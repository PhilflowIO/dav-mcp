#!/bin/sh
# Reads .github/ci-images.txt, the list of every container image CI pulls, and
# answers with the mirror references on ghcr.io (see that file for why).
#
#   ci-images.sh refs [manifest]  "<name>=<mirror ref>" per image, for $GITHUB_OUTPUT
#   ci-images.sh list [manifest]  "<name> <source repo@digest> <mirror repo:tag> <digest>"
#   ci-images.sh check            each public default named in the manifest is
#                                 present verbatim in its file
#
# A mirror reference is ghcr.io/philflowio/ci-mirror/<name>:<tag>@<digest>:
# pulled by digest, so a moved tag can never change what CI runs. Output
# names use "_" for "-" (distroless-nodejs22 -> distroless_nodejs22), so
# they work in ${{ steps.x.outputs.<name> }}.
set -eu

MIRROR=ghcr.io/philflowio/ci-mirror
root=$(cd "$(dirname "$0")/../.." && pwd)
cmd=${1:-}
manifest=${2:-"$root/.github/ci-images.txt"}

entries() {
  grep -v '^[[:space:]]*\(#\|$\)' "$manifest"
}

case "$cmd" in
  refs | list)
    entries | while read -r name source _file; do
      repo_tag=${source%@*}
      digest=${source#*@}
      tag=${repo_tag##*:}
      repo=${repo_tag%:*}
      case "$digest" in
        sha256:????????????????????????????????????????????????????????????????) ;;
        *) echo "::error::${name}: ${source} is not pinned to a sha256 digest" >&2; exit 1 ;;
      esac
      if [ "$cmd" = refs ]; then
        echo "$(echo "$name" | tr - _)=${MIRROR}/${name}:${tag}@${digest}"
      else
        echo "${name} ${repo}@${digest} ${MIRROR}/${name}:${tag} ${digest}"
      fi
    done
    ;;
  check)
    status=0
    while read -r name source file; do
      [ "$file" = - ] && continue
      if ! grep -qF "$source" "$root/$file"; then
        echo "::error file=${file}::${file} does not fall back to ${source} (${name} in .github/ci-images.txt); a build outside CI would pull different bytes"
        status=1
      fi
    done <<EOF
$(entries)
EOF
    exit "$status"
    ;;
  *)
    echo "usage: $0 refs|list [manifest] | check" >&2
    exit 2
    ;;
esac
