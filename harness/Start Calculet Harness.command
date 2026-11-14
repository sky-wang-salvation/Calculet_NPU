#!/bin/zsh
set -e
cd -- "${0:A:h}"
local_node="${PWD:h:h}/.tools/node-v24.22.3-darwin-arm64/bin"
if [[ -x "$local_node/node" ]]; then
  export PATH="$local_node:$PATH"
fi
node --version
npm run harness
