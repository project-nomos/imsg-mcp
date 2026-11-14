#!/usr/bin/env bash
# Creates a self-signed code-signing identity in a keychain of its own, so imsg-mcp can
# then be signed without a GUI (for example over SSH). Run it once, as the user who builds,
# in a Terminal on the Mac's screen (directly or over Screen Sharing): codesign only uses
# trusted identities, and macOS asks for your password in a dialog to trust the
# certificate. That dialog cannot appear over SSH.
#
#   scripts/make-signing-identity.sh ["imsg-mcp local signing"]
#
# It writes:
#   ~/Library/Keychains/imsg-mcp-signing.keychain-db   the keychain holding the identity
#   ~/Library/Keychains/imsg-mcp-signing.pass          that keychain's password (mode 0600)
#
# Then sign with:
#   IMSG_MCP_SIGN_KEYCHAIN=~/Library/Keychains/imsg-mcp-signing.keychain-db \
#     scripts/sign.sh "imsg-mcp local signing"
#
# Back up both files. macOS ties Full Disk Access and Automation to the signing identity,
# so every future update must be signed with this same one or the grants are lost.
# The keychain is not added to your search list, so it never prompts other apps.
set -euo pipefail

NAME="${1:-imsg-mcp local signing}"
KEYCHAIN="${IMSG_MCP_SIGN_KEYCHAIN:-$HOME/Library/Keychains/imsg-mcp-signing.keychain-db}"
PASSFILE="${IMSG_MCP_SIGN_KEYCHAIN_PASSWORD_FILE:-${KEYCHAIN%.keychain-db}.pass}"
# macOS's own LibreSSL writes PKCS#12 files that `security import` accepts; OpenSSL 3's
# defaults are not always accepted, so use it explicitly.
OPENSSL=/usr/bin/openssl

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "error: macOS only" >&2
  exit 1
fi
if [[ -e "$KEYCHAIN" ]]; then
  echo "error: $KEYCHAIN already exists; reuse it, or delete it and its .pass file first" >&2
  exit 1
fi

umask 077
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mkdir -p "$(dirname "$KEYCHAIN")" "$(dirname "$PASSFILE")"

"$OPENSSL" rand -hex 32 > "$PASSFILE"
chmod 600 "$PASSFILE"
password="$(cat "$PASSFILE")"
p12_password="$("$OPENSSL" rand -hex 16)"

cat > "$work/openssl.cnf" <<EOF
[req]
distinguished_name = dn
x509_extensions = ext
prompt = no
[dn]
CN = $NAME
[ext]
basicConstraints = critical, CA:false
keyUsage = critical, digitalSignature
extendedKeyUsage = critical, codeSigning
subjectKeyIdentifier = hash
EOF

echo "==> Creating a self-signed code-signing certificate \"$NAME\" (10 years)"
"$OPENSSL" req -x509 -newkey rsa:3072 -sha256 -days 3650 -nodes \
  -keyout "$work/key.pem" -out "$work/cert.pem" -config "$work/openssl.cnf" 2>/dev/null
"$OPENSSL" pkcs12 -export -inkey "$work/key.pem" -in "$work/cert.pem" -name "$NAME" \
  -out "$work/identity.p12" -passout "pass:$p12_password"

echo "==> Storing it in $KEYCHAIN"
security create-keychain -p "$password" "$KEYCHAIN"
security set-keychain-settings "$KEYCHAIN" # no automatic locking while logged in
security unlock-keychain -p "$password" "$KEYCHAIN"
security import "$work/identity.p12" -k "$KEYCHAIN" -P "$p12_password" -T /usr/bin/codesign >/dev/null
# Let codesign use the key without a GUI prompt (needed over SSH).
security set-key-partition-list -S apple-tool:,apple: -s -k "$password" "$KEYCHAIN" >/dev/null

echo "==> Trusting the certificate for code signing (macOS asks for your password)"
if ! security add-trusted-cert -r trustRoot -p codeSign -k "$KEYCHAIN" "$work/cert.pem"; then
  security delete-keychain "$KEYCHAIN" 2>/dev/null || true
  rm -f "$PASSFILE"
  echo "error: could not trust the certificate. Run this in a Terminal on the Mac's screen" >&2
  echo "(not over SSH) and approve the password dialog." >&2
  exit 1
fi

echo "==> Checking that codesign can use it"
cp /usr/bin/true "$work/probe"
codesign --force --sign "$NAME" --keychain "$KEYCHAIN" --timestamp=none "$work/probe"
codesign --verify --strict "$work/probe"
echo "    designated requirement: $(codesign -d -r- "$work/probe" 2>&1 | sed -n 's/^#* *designated => //p')"

cat <<NEXT

Done. Back up these two files; future updates must be signed with this identity:
  $KEYCHAIN
  $PASSFILE

Sign the build with:
  IMSG_MCP_SIGN_KEYCHAIN="$KEYCHAIN" scripts/sign.sh "$NAME"
NEXT
