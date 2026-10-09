#!/bin/sh
# Starts the CalDAV backend for the Docker smoke tests: container `radicale` on
# the `davci` network, listening on radicale:5232.
#
# Not from a Radicale image on Docker Hub: Docker Hub limits anonymous pulls per
# IP, and GitHub runners share theirs, so CI failed with "toomanyrequests"
# (#140). It runs the official Python image, pinned to its multi-arch index, and
# Radicale from PyPI, pinned with hashes in radicale/requirements.txt. Settings
# are in radicale/config.
#
# CI sets PYTHON_IMAGE to its copy on ghcr.io (.github/ci-images.txt): ECR
# Public rate-limits anonymous pulls from shared runner IPs as well (#142).
# Without it, the default is the Docker Official Images mirror on ECR Public,
# with the same digest.
set -eu

PYTHON_IMAGE=${PYTHON_IMAGE:-'public.ecr.aws/docker/library/python:3.13-alpine@sha256:2d9aefe2fef018a7eb2c13064c89c71929800fd2e5dccdbf52ea5da5bb8d929a'}
echo "Python image: ${PYTHON_IMAGE}"
dir=$(cd "$(dirname "$0")/radicale" && pwd)

docker network inspect davci >/dev/null 2>&1 || docker network create davci
docker run -d --name radicale --network davci \
  -v "${dir}:/radicale:ro" \
  "$PYTHON_IMAGE" \
  sh -c 'pip install --quiet --no-cache-dir --disable-pip-version-check --root-user-action=ignore --only-binary=:all: --require-hashes -r /radicale/requirements.txt && exec python -m radicale --config /radicale/config'

# pip install runs first, so this allows longer than a ready-made image needed.
for _ in $(seq 1 60); do
  docker logs radicale 2>&1 | grep -q 'Radicale server ready' && exit 0
  [ "$(docker inspect -f '{{.State.Running}}' radicale)" = true ] || break
  sleep 2
done
echo "::error::Radicale did not become ready"
docker logs radicale
exit 1
