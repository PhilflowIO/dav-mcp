#!/bin/sh
# Copies or checks the CI image mirror (see .github/ci-images.txt).
#
#   mirror-ci-images.sh copy   [manifest...]  copy what is missing, then verify
#   mirror-ci-images.sh verify [manifest...]  only verify; never writes
#   mirror-ci-images.sh visibility [manifest...]  warn for a public package
#
# Without a manifest argument it reads .github/ci-images.txt. Expects skopeo
# to be logged in to ghcr.io (copy needs packages: write, verify read).
#
# copy: --all copies every platform plus the index, --preserve-digests
# refuses any copy that would change a digest, and the source is pulled by
# digest, so a moved tag upstream cannot change what lands in the mirror. A
# failed copy is tried again from scratch: skopeo's --retry-times does not
# cover the token request. For Docker Hub images it also tries mirror.gcr.io,
# Google's cache of Docker Hub: in the first runs, Docker Hub's token endpoint
# answered every request for tonistiigi/binfmt with 504. The digest is the
# same index, and --preserve-digests plus the read-back hold any source to it.
#
# verify, and copy after copying: the mirror is read back by digest and
# hashed, independent of what skopeo reported.
set -eu

here=$(cd "$(dirname "$0")" && pwd)
mode=${1:-}
[ $# -gt 0 ] && shift
[ $# -gt 0 ] || set -- "$here/../ci-images.txt"

case "$mode" in
  copy | verify | visibility) ;;
  *) echo "usage: $0 copy|verify|visibility [manifest...]" >&2; exit 2 ;;
esac

list=$(mktemp)
trap 'rm -f "$list"' EXIT
for manifest in "$@"; do
  "$here/ci-images.sh" list "$manifest" >> "$list"
done
sort -u -o "$list" "$list"

status=0
while read -r name source target digest; do
  mirror="${target%:*}@${digest}"

  if [ "$mode" = visibility ]; then
    # Anonymous, the way anyone outside this repository would ask: a public
    # package answers with the manifest.
    repo=${target#ghcr.io/}
    repo=${repo%:*}
    token=$(curl -fsS "https://ghcr.io/token?service=ghcr.io&scope=repository:${repo}:pull" | jq -r .token)
    code=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer ${token}" \
      -H 'Accept: application/vnd.oci.image.index.v1+json,application/vnd.docker.distribution.manifest.list.v2+json' \
      "https://ghcr.io/v2/${repo}/manifests/${digest}")
    if [ "$code" = 200 ]; then
      echo "::warning::${name}: ghcr.io/${repo} is public. Set it to private: https://github.com/users/PhilflowIO/packages/container/$(echo "${repo#philflowio/}" | sed 's|/|%2F|g')/settings"
    else
      echo "${name}: ghcr.io/${repo} refuses anonymous pulls (HTTP ${code})"
    fi
    continue
  fi

  if skopeo inspect --raw "docker://${mirror}" < /dev/null > /dev/null 2>&1; then
    echo "${name}: ${mirror} is mirrored"
  elif [ "$mode" = verify ]; then
    echo "::error::${name}: ${mirror} is not in the mirror. Run \"Mirror CI images\" from this branch by hand (Actions, Run workflow, or: gh workflow run mirror-ci-images.yml --ref <branch>) to copy the new digest, then re-run this job. From a fork, a maintainer does that from a branch of this repository."
    status=1
    continue
  else
    echo "${name}: copying ${source} to ${target}"
    candidates="$source"
    case "$source" in
      docker.io/*) candidates="$source mirror.gcr.io/${source#docker.io/}" ;;
    esac
    copied=false
    for attempt in 1 2 3; do
      for from in $candidates; do
        if skopeo copy --all --preserve-digests --retry-times 5 "docker://${from}" "docker://${target}" < /dev/null; then
          echo "${name}: copied from ${from}"
          copied=true
          break 2
        fi
        echo "${name}: attempt ${attempt} from ${from} failed"
      done
      sleep $((attempt * 20))
    done
    if [ "$copied" != true ]; then
      echo "::error::${name}: could not copy ${source} to ${target}"
      status=1
      continue
    fi
  fi

  served="sha256:$(skopeo inspect --raw "docker://${mirror}" < /dev/null | sha256sum | cut -d' ' -f1)"
  if [ "$served" != "$digest" ]; then
    echo "::error::${name}: ${mirror} serves a manifest with digest ${served}"
    status=1
    continue
  fi
  echo "${name}: ${mirror} verified"
done < "$list"
exit "$status"
