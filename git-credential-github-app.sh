#!/bin/sh
# Git credential helper that mints a fresh GitHub App installation token.
# Requires: openssl, curl, jq
# Config via env: GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY_PATH, GITHUB_APP_INSTALLATION_ID

if [ "$1" != "get" ]; then exit 0; fi

NOW=$(date +%s)
IAT=$((NOW - 60))
EXP=$((NOW + 300))

HEADER=$(printf '{"alg":"RS256","typ":"JWT"}' | openssl base64 -e | tr -d '=\n' | tr '/+' '_-')
PAYLOAD=$(printf '{"iat":%d,"exp":%d,"iss":"%s"}' "$IAT" "$EXP" "$GITHUB_APP_ID" | openssl base64 -e | tr -d '=\n' | tr '/+' '_-')
SIG=$(printf '%s.%s' "$HEADER" "$PAYLOAD" | openssl dgst -sha256 -sign "$GITHUB_APP_PRIVATE_KEY_PATH" -binary | openssl base64 -e | tr -d '=\n' | tr '/+' '_-')
JWT="${HEADER}.${PAYLOAD}.${SIG}"

TOKEN=$(curl -s -X POST \
  -H "Authorization: Bearer $JWT" \
  -H "Accept: application/vnd.github+json" \
  "https://api.github.com/app/installations/${GITHUB_APP_INSTALLATION_ID}/access_tokens" \
  | jq -r .token)

printf 'protocol=https\nhost=github.com\nusername=x-access-token\npassword=%s\n' "$TOKEN"
