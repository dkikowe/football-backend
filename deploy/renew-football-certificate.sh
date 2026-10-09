#!/bin/sh
# Dedicated DTLS trust; HTTPS and the existing nginx installation are untouched.
set -eu
umask 077
test "$(id -u)" = 0
exec 9>/run/football-certificate.lock
flock -n 9 || exit 0
pki=/etc/football/pki
tls=/etc/football/tls
install -d -m 700 "$pki"
install -d -o root -g football -m 750 "$tls"
if [ ! -f "$pki/ca.pem" ]; then
  if [ -e "$pki/ca.key" ] || [ -e "$tls/server.pem" ]; then
    echo 'Existing DTLS trust is incomplete; restore the original CA instead of rotating silently.' >&2
    exit 1
  fi
  openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 1825 \
    -subj '/CN=Football Dedicated Transport CA' \
    -addext 'basicConstraints=critical,CA:TRUE' \
    -addext 'keyUsage=critical,keyCertSign,cRLSign' \
    -keyout "$pki/ca.key" -out "$pki/ca.pem" 2>/dev/null
fi
if [ -f "$tls/server.pem" ] && [ -f "$tls/server.key" ]; then
  chown root:football "$tls/server.pem" "$tls/server.key"
  chmod 640 "$tls/server.pem" "$tls/server.key"
  cert_key=$(openssl x509 -in "$tls/server.pem" -pubkey -noout | openssl sha256)
  private_key=$(openssl pkey -in "$tls/server.key" -pubout | openssl sha256)
  if [ "$cert_key" = "$private_key" ] && \
    openssl verify -verify_hostname football-game -CAfile "$pki/ca.pem" "$tls/server.pem" >/dev/null 2>&1 && \
    openssl x509 -checkend 2592000 -noout -in "$tls/server.pem" >/dev/null; then
    exit 0
  fi
fi
tmp=$(mktemp -d "$pki/renew.XXXXXX")
trap 'rm -rf "$tmp"' EXIT
if [ ! -f "$tls/server.key" ]; then
  openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "$tmp/server.key" 2>/dev/null
  install -o root -g football -m 640 "$tmp/server.key" "$tls/server.key"
fi
openssl req -new -key "$tls/server.key" -subj '/CN=football-game' -out "$tmp/server.csr"
cat > "$tmp/server.ext" <<'EOF'
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=DNS:football-game,IP:167.172.156.89
EOF
openssl x509 -req -in "$tmp/server.csr" -CA "$pki/ca.pem" -CAkey "$pki/ca.key" \
  -CAcreateserial -days 90 -sha256 -extfile "$tmp/server.ext" -out "$tmp/server.pem" 2>/dev/null
openssl verify -CAfile "$pki/ca.pem" "$tmp/server.pem" >/dev/null
install -o root -g football -m 640 "$tmp/server.pem" "$tls/server.pem.next"
mv "$tls/server.pem.next" "$tls/server.pem"
# Active matches keep their certificate; the next normal match process loads renewal.
echo 'Football DTLS certificate is ready; no active match was restarted.'
