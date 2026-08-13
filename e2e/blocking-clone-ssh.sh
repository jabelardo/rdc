#!/usr/bin/env bash
set -euo pipefail

remote_file=/tmp/rdc-e2e-clone-cancellation-remote
ready_file=/tmp/rdc-e2e-clone-cancellation-ready
release_file=/tmp/rdc-e2e-clone-cancellation-release

printf '%s\n' 'remote: Counting objects: 50% (1/2)' >&2
: >"${ready_file}"
while [ ! -e "${release_file}" ]; do
  sleep 0.01
done

exec git-upload-pack "$(<"${remote_file}")"
