#!/usr/bin/env bash
# Format trusted, operator-supplied SSH key material for OpenSSH known_hosts.
# Never discover trust via ssh-keyscan. Diagnostics must not contain key data.
set -euo pipefail
port=${SERVER_PORT:-22}
[[ "$port" =~ ^[1-9][0-9]{0,4}$ && "$port" -le 65535 ]] || { echo 'Invalid SSH port' >&2; exit 1; }
[[ "${SERVER_HOST:-}" =~ ^[A-Za-z0-9][A-Za-z0-9.-]*$ ]] || { echo 'Invalid SSH destination' >&2; exit 1; }
host=$SERVER_HOST
if [[ "$port" != 22 ]]; then host="[$host]:$port"; fi
awk -v host="$host" 'NF >= 3 && $1 !~ /^#/ && $2 ~ /^(ssh-|ecdsa-|sk-)/ {print host, $2, $3; found=1} END {exit !found}' <<< "${VPS_SSH_HOST_KEY:?pinned SSH host key required}"
