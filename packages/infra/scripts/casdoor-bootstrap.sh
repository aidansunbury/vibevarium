#!/usr/bin/env bash
# Casdoor bootstrap — idempotent config of a fresh Casdoor for vibevarium.
#
# Why this exists (no Terraform): Casdoor's admin surface is a runtime REST
# API, not declarative config. The only things that need one-time setup are the
# org, the DCR toggle, and the GUI application — per-app OIDC clients are then
# created on demand via DCR (RFC 7591), never declaratively. This script does
# those three setup calls idempotently using an admin *session cookie* (the
# admin API rejects client-credentials tokens, and access-key secrets are
# masked on read — so a session is the workable admin credential).
#
# Usage:
#   CASDOOR_URL=https://auth.vibevarium.com \
#   CASDOOR_ADMIN_PASSWORD=… \        # from AWS SM /vibevarium/prod/CASDOOR_ADMIN_PASSWORD
#   GUI_REDIRECT_BASE=https://platform.vibevarium.com \
#   bash scripts/casdoor-bootstrap.sh
#
# Idempotent: safe to run repeatedly; each step is a no-op when already done.
set -euo pipefail

CASDOOR_URL="${CASDOOR_URL:-https://auth.vibevarium.com}"
ORG="${CASDOOR_ORG:-vibevarium}"
GUI_REDIRECT_BASE="${GUI_REDIRECT_BASE:-https://platform.vibevarium.com}"
CONTROL_PLANE_BASE_URL="${CONTROL_PLANE_BASE_URL:-https://api.vibevarium.com}"
: "${CASDOOR_ADMIN_PASSWORD:?Set CASDOOR_ADMIN_PASSWORD (from AWS SM)}"

JAR="$(mktemp)"
trap 'rm -f "$JAR"' EXIT

echo "=== Casdoor bootstrap: $CASDOOR_URL (org $ORG) ==="

# 1. Admin session
curl -sf -c "$JAR" -X POST "$CASDOOR_URL/api/login" \
  -H "content-type: application/json" \
  -d "{\"application\":\"app-built-in\",\"organization\":\"built-in\",\"username\":\"admin\",\"password\":\"$CASDOOR_ADMIN_PASSWORD\",\"type\":\"login\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);assert d.get('status')=='ok',d;print('  signed in as built-in/admin')"

api() { # api <method> <path> [json-body]
  local method="$1" path="$2" body="${3:-}"
  if [ -n "$body" ]; then
    curl -sf -b "$JAR" -X "$method" "$CASDOOR_URL$path" -H "content-type: application/json" -d "$body"
  else
    curl -sf -b "$JAR" -X "$method" "$CASDOOR_URL$path"
  fi
}

# 2. Org exists?
if api GET "/api/get-organization?id=admin/$ORG" | python3 -c "import sys,json;exit(0 if (json.load(sys.stdin).get('data') or {}).get('name') else 1)" 2>/dev/null; then
  echo "  org '$ORG' exists"
else
  api POST "/api/add-organization" "{\"owner\":\"admin\",\"name\":\"$ORG\",\"displayName\":\"$ORG\",\"websiteUrl\":\"https://$ORG.com\",\"passwordType\":\"plain\",\"countryCodes\":[\"US\"],\"tags\":[],\"initScore\":2000,\"enableSoftDeletion\":false,\"isProfilePublic\":true,\"useEmailAsUsername\":false,\"enableTour\":true,\"mfaRememberInHours\":12,\"mfaProps\":{\"mfaType\":\"\",\"secret\":\"\",\"recoveryCodesEnabled\":false},\"accountItems\":[],\"dcrPolicy\":\"\"}" \
    | python3 -c "import sys,json;d=json.load(sys.stdin);assert d.get('status')=='ok',d;print('  created org $ORG')"
fi

# 3. Enable DCR for global clients and the organization issuer for org users.
for dcr_org in built-in "$ORG"; do
  CUR=$(api GET "/api/get-organization?id=admin/$dcr_org" | python3 -c "import sys,json;print((json.load(sys.stdin).get('data') or {}).get('dcrPolicy',''))")
  if [ "$CUR" = "open" ]; then
    echo "  dcrPolicy already open for $dcr_org"
  else
    api GET "/api/get-organization?id=admin/$dcr_org" | python3 -c "import sys,json;o=json.load(sys.stdin)['data'];o['dcrPolicy']='open';json.dump(o,open('$JAR.org.json','w'))"
    api POST "/api/update-organization?id=admin/$dcr_org" "$(cat "$JAR.org.json")" \
      | python3 -c "import sys,json;d=json.load(sys.stdin);assert d.get('status')=='ok',d;print('  enabled dcrPolicy=open for $dcr_org')"
  fi
done

api GET "/api/get-organization?id=admin/$ORG" | python3 -c "import sys,json;o=json.load(sys.stdin)['data'];o['useOrganizationIssuer']=True;json.dump(o,open('$JAR.org.json','w'))"
api POST "/api/update-organization?id=admin/$ORG" "$(cat "$JAR.org.json")" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);assert d.get('status')=='ok',d;print('  enabled organization issuer for $ORG')"

# 4. Create or reconcile the GUI application and its API callback.
if api GET "/api/get-organization-applications?organization=$ORG" | python3 -c "import sys,json;exit(0 if any(o.get('name')=='$ORG' for o in (json.load(sys.stdin).get('data') or [])) else 1)" 2>/dev/null; then
  api GET "/api/get-organization-applications?organization=$ORG" | python3 -c "
import sys,json
apps=json.load(sys.stdin).get('data') or []
app=[o for o in apps if o.get('name')=='$ORG'][0]
app['homepageUrl']='$GUI_REDIRECT_BASE'
app['redirectUris']=['$CONTROL_PLANE_BASE_URL/auth/callback']
app['postLogoutRedirectUris']=['$GUI_REDIRECT_BASE/']
json.dump(app,open('$JAR.app.json','w'))
"
  api POST "/api/update-application?id=admin/$ORG" "$(cat "$JAR.app.json")" \
    | python3 -c "import sys,json;d=json.load(sys.stdin);assert d.get('status')=='ok',d;print('  reconciled GUI application $ORG')"
else
  api POST "/api/add-application" "{\"owner\":\"$ORG\",\"name\":\"$ORG\",\"displayName\":\"$ORG control plane\",\"organization\":\"$ORG\",\"homepageUrl\":\"$GUI_REDIRECT_BASE\",\"redirectUris\":[\"$CONTROL_PLANE_BASE_URL/auth/callback\"],\"postLogoutRedirectUris\":[\"$GUI_REDIRECT_BASE/\"],\"grantTypes\":[\"authorization_code\",\"refresh_token\",\"client_credentials\"],\"responseTypes\":[\"code\"],\"tokenFormat\":\"JWT\",\"expireInHours\":168,\"refreshExpireInHours\":720,\"enablePassword\":true,\"enableSignUp\":false,\"enableSigninSession\":true,\"enableLinkWithEmail\":true,\"formOffset\":1}" \
    | python3 -c "import sys,json;d=json.load(sys.stdin);assert d.get('status')=='ok',d;print('  created GUI application $ORG')"
fi

# 5. Write the GUI app credentials to AWS Secrets Manager (never printed).
if command -v aws >/dev/null 2>&1 && { [ -n "${AWS_PROFILE:-}" ] || [ -n "${AWS_ACCESS_KEY_ID:-}" ]; }; then
  CREDS=$(api GET "/api/get-organization-applications?organization=$ORG" | python3 -c "
import sys,json
d=json.load(sys.stdin)
app=[o for o in (d.get('data') or []) if o.get('name')=='$ORG'][0]
print(app['clientId']); print(app.get('clientSecret',''))
")
  GID=$(echo "$CREDS" | sed -n '1p')
  GSEC=$(echo "$CREDS" | sed -n '2p')
  upsert() {
    aws secretsmanager create-secret --name "$1" --secret-string "$2" >/dev/null 2>&1 \
      || aws secretsmanager put-secret-value --secret-id "$1" --secret-string "$2" >/dev/null
  }
  upsert "/vibevarium/prod/GUI_APP_ID" "$GID" && echo "  stored /vibevarium/prod/GUI_APP_ID"
  upsert "/vibevarium/prod/GUI_APP_SECRET" "$GSEC" && echo "  stored /vibevarium/prod/GUI_APP_SECRET"
else
  echo "  (AWS CLI credentials not set — store the GUI creds in AWS SM manually as"
  echo "   /vibevarium/prod/GUI_APP_ID and /vibevarium/prod/GUI_APP_SECRET)"
fi
echo "=== Bootstrap complete ==="
