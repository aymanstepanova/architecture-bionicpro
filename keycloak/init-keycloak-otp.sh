#!/bin/sh
set -eu

KEYCLOAK_URL="${KEYCLOAK_URL:-http://keycloak:8080}"
KEYCLOAK_REALM="${KEYCLOAK_REALM:-reports-realm}"
KEYCLOAK_ADMIN_USER="${KEYCLOAK_ADMIN_USER:-admin}"
KEYCLOAK_ADMIN_PASSWORD="${KEYCLOAK_ADMIN_PASSWORD:-admin}"
TARGET_USERS="${TARGET_USERS:-user1,user2,admin1,prothetic1,prothetic2,prothetic3}"

echo "Waiting for Keycloak at ${KEYCLOAK_URL}..."
for i in $(seq 1 60); do
  if curl -sf "${KEYCLOAK_URL}/realms/master/.well-known/openid-configuration" >/dev/null; then
    break
  fi
  sleep 2
done
curl -sf "${KEYCLOAK_URL}/realms/master/.well-known/openid-configuration" >/dev/null

echo "Requesting admin token..."
TOKEN_RESPONSE="$(curl -sS -X POST "${KEYCLOAK_URL}/realms/master/protocol/openid-connect/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "client_id=admin-cli" \
  -d "username=${KEYCLOAK_ADMIN_USER}" \
  -d "password=${KEYCLOAK_ADMIN_PASSWORD}" \
  -d "grant_type=password")"

ACCESS_TOKEN="$(echo "${TOKEN_RESPONSE}" | sed -n 's/.*"access_token":"\([^"]*\)".*/\1/p')"
if [ -z "${ACCESS_TOKEN}" ]; then
  echo "Failed to get Keycloak admin token"
  echo "${TOKEN_RESPONSE}"
  exit 1
fi

echo "Ensuring CONFIGURE_TOTP required action exists and enabled..."
RA_CONFIG="$(curl -sS -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  "${KEYCLOAK_URL}/admin/realms/${KEYCLOAK_REALM}/authentication/required-actions/CONFIGURE_TOTP")"
RA_UPDATED="$(echo "${RA_CONFIG}" | sed 's/"enabled":[^,}]*/"enabled":true/g' | sed 's/"defaultAction":[^,}]*/"defaultAction":true/g')"
curl -sS -o /dev/null -X PUT \
  "${KEYCLOAK_URL}/admin/realms/${KEYCLOAK_REALM}/authentication/required-actions/CONFIGURE_TOTP" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "${RA_UPDATED}"

OLD_IFS="${IFS}"
IFS=','
set -- ${TARGET_USERS}
IFS="${OLD_IFS}"

for username in "$@"; do
  USER_JSON="$(curl -sS -H "Authorization: Bearer ${ACCESS_TOKEN}" \
    "${KEYCLOAK_URL}/admin/realms/${KEYCLOAK_REALM}/users?username=${username}&exact=true")"
  USER_ID="$(echo "${USER_JSON}" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p' | head -n 1)"

  if [ -z "${USER_ID}" ]; then
    echo "User not found, skipping: ${username}"
    continue
  fi

  HTTP_CODE="$(curl -sS -o /dev/null -w "%{http_code}" -X PUT \
    "${KEYCLOAK_URL}/admin/realms/${KEYCLOAK_REALM}/users/${USER_ID}" \
    -H "Authorization: Bearer ${ACCESS_TOKEN}" \
    -H "Content-Type: application/json" \
    -d '{"requiredActions":["CONFIGURE_TOTP"]}')"

  if [ "${HTTP_CODE}" = "204" ]; then
    echo "Configured OTP required action for ${username}"
  else
    echo "Failed to update ${username}, HTTP ${HTTP_CODE}"
    exit 1
  fi
done

echo "Keycloak OTP init complete."
