#!/usr/bin/env bash
# Create a self-signed certificate for localhost so the stack starts on a laptop.
# Development only: browsers will warn. Production uses a real certificate
# (see docs/deploy-checklist.md).
set -euo pipefail

cd "$(dirname "$0")/.."
cert_dir="compose/certs"
force=false
[[ "${1:-}" == "--force" ]] && force=true

if [[ -f "$cert_dir/fullchain.pem" && "$force" != true ]]; then
  printf 'certificate already exists in %s (use --force to replace it)\n' "$cert_dir"
  exit 0
fi

mkdir -p "$cert_dir"
openssl req -x509 -newkey rsa:2048 -nodes -days 30 -sha256 \
  -subj "/CN=localhost" \
  -addext "subjectAltName=DNS:localhost,IP:127.0.0.1" \
  -keyout "$cert_dir/privkey.pem" -out "$cert_dir/fullchain.pem" 2>/dev/null
# nginx runs as uid 101 inside its container and must read the key. Acceptable for
# a throwaway local key; a production key is owned by 101 with mode 0400.
chmod 0644 "$cert_dir/privkey.pem" "$cert_dir/fullchain.pem"
printf 'wrote %s/fullchain.pem and %s/privkey.pem (valid 30 days)\n' "$cert_dir" "$cert_dir"
