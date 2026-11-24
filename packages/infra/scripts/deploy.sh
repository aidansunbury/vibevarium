#!/usr/bin/env bash
# Vibevarium infrastructure deploy script.
#
# Usage:
#   cd packages/infra
#   source ../../.env          # Cloudflare token + account
#   export TERRARIUM_DOMAIN=vibevarium.com
#   export CLOUDFLARE_ZONE_ID=c6ae3b555628f3c6c0fb3883c479dcc4
#   export AWS_PROFILE=givefront-dev
#   bash scripts/deploy.sh
#
# What it does:
#   1. alchemy deploy (VPC, EC2, RDS, EIP, DNS)
#   2. Extract SSH private key from alchemy state → .secrets/
#   3. Associate the Elastic IP to the EC2 instance
#   4. Wait for the instance to be reachable via SSH
#   5. Read the RDS master password from Secrets Manager
#   6. Create the control_plane database (idempotent)
#   7. SCP compose files + build context to the box
#   8. docker compose up
#   9. Print verification URLs
set -euo pipefail

cd "$(dirname "$0")/.."
INFRA_DIR="$(pwd)"
REPO_ROOT="$(cd ../.. && pwd)"

# ── Validate required env ──────────────────────────────────────────────────
: "${TERRARIUM_DOMAIN:?Set TERRARIUM_DOMAIN (e.g. vibevarium.com)}"
: "${CLOUDFLARE_ZONE_ID:?Set CLOUDFLARE_ZONE_ID}"
: "${AWS_PROFILE:?Set AWS_PROFILE (e.g. givefront-dev)}"
export AWS_REGION="${AWS_REGION:-us-east-1}"

echo "=== Vibevarium infra deploy ==="
echo "  Domain:  $TERRARIUM_DOMAIN"
echo "  Zone:    $CLOUDFLARE_ZONE_ID"
echo "  Profile: $AWS_PROFILE"
echo "  Region:  $AWS_REGION"
echo

# ── 1. Deploy the stack ───────────────────────────────────────────────────
echo ">>> alchemy deploy…"
cd "$INFRA_DIR"
pnpm exec alchemy deploy --config ./src/main.ts --yes

# ── 2. Read stack outputs + extract SSH key ───────────────────────────────
echo ">>> Reading stack outputs…"
# Alchemy writes local state under packages/infra/.alchemy (the deploy cwd),
# keyed by the stage (default "live_<user>"). Discover the current stage's
# output file rather than hardcoding a path.
STATE_DIR=$(find "$INFRA_DIR/.alchemy/state/VibevariumInfra" -mindepth 1 -maxdepth 1 -type d ! -name '*.stale-*' | head -1)
OUTPUT_FILE="$STATE_DIR/__stack_output__.json"
if [ ! -f "$OUTPUT_FILE" ]; then
  echo "ERROR: no stack output file at $OUTPUT_FILE"
  exit 1
fi

EIP=$(jq -r '.elasticIp' "$OUTPUT_FILE")
EIP_ALLOC=$(jq -r '.elasticIpAllocationId' "$OUTPUT_FILE")
INSTANCE_ID=$(jq -r '.instanceId' "$OUTPUT_FILE")
DB_ENDPOINT=$(jq -r '.dbEndpoint' "$OUTPUT_FILE")
DB_SECRET_ARN=$(jq -r '.dbMasterSecretArn' "$OUTPUT_FILE")

echo "  EIP:        $EIP ($EIP_ALLOC)"
echo "  Instance:   $INSTANCE_ID"
echo "  RDS:        $DB_ENDPOINT"
echo "  Secret ARN: $DB_SECRET_ARN"

# Extract SSH private key from state (Redacted values are stored as the raw string)
echo ">>> Extracting SSH key…"
mkdir -p "$REPO_ROOT/.secrets"
SSH_KEY="$REPO_ROOT/.secrets/vibevarium-key.pem"
# The key is stored as a Redacted value: a {"__redacted__": "<pem>"} wrapper.
# Unwrap to the raw PEM; fall back to the KeyPair resource state if absent.
jq -r '.sshPrivateKey.__redacted__ // .sshPrivateKey // empty' "$OUTPUT_FILE" > "$SSH_KEY"
if [ ! -s "$SSH_KEY" ]; then
  KEY_STATE=$(find "$STATE_DIR" -name '*.json' ! -name '__stack_output__.json' -exec grep -l 'privateKey' {} \; | head -1)
  if [ -n "$KEY_STATE" ]; then
    jq -r '.attr.privateKey.__redacted__ // .attr.privateKey // .privateKey.__redacted__ // .privateKey // empty' "$KEY_STATE" > "$SSH_KEY"
  fi
fi
chmod 600 "$SSH_KEY"
if [ ! -s "$SSH_KEY" ]; then
  echo "ERROR: could not extract SSH private key from state"
  exit 1
fi
echo "  Key saved to $SSH_KEY"

# ── 3. Associate EIP ─────────────────────────────────────────────────────
echo ">>> Associating Elastic IP…"
aws ec2 associate-address \
  --instance-id "$INSTANCE_ID" \
  --allocation-id "$EIP_ALLOC" \
  --region "$AWS_REGION" \
  --profile "$AWS_PROFILE" || echo "(already associated)"

# ── 4. Wait for SSH ──────────────────────────────────────────────────────
SSH_OPTS="-i $SSH_KEY -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10"
SSH_USER="ubuntu"

echo ">>> Waiting for SSH on $EIP…"
for i in $(seq 1 30); do
  if ssh $SSH_OPTS "$SSH_USER@$EIP" "echo ok" 2>/dev/null; then
    echo "  SSH ready"
    break
  fi
  echo "  attempt $i/30…"
  sleep 10
done

# ── 5. Read RDS password ─────────────────────────────────────────────────
echo ">>> Reading RDS master password…"
DB_SECRET=$(aws secretsmanager get-secret-value \
  --secret-id "$DB_SECRET_ARN" \
  --region "$AWS_REGION" \
  --profile "$AWS_PROFILE" \
  --query 'SecretString' --output text)
DB_PASSWORD=$(echo "$DB_SECRET" | jq -r '.password')
DB_USER=$(echo "$DB_SECRET" | jq -r '.username')

# ── 6. Create databases (idempotent) ─────────────────────────────────────
# RDS creates one initial database (named `postgres` via aws.ts dbName). The
# control_plane + casdoor databases live alongside it on the same instance
# (the one-instance-many-databases pattern).
echo ">>> Creating control_plane + casdoor databases on RDS (via EC2)…"
ssh $SSH_OPTS "$SSH_USER@$EIP" bash -s <<REMOTE
set -euo pipefail
export PGPASSWORD='$DB_PASSWORD'
for db in control_plane casdoor; do
  psql -h "$DB_ENDPOINT" -U "$DB_USER" -d postgres -tc \
    "SELECT 1 FROM pg_database WHERE datname='\$db'" | grep -q 1 || \
  psql -h "$DB_ENDPOINT" -U "$DB_USER" -d postgres -c \
    "CREATE DATABASE \$db"
  echo "\$db database ready"
done
REMOTE

# ── 7. Push compose + build context ───────────────────────────────────────
echo ">>> Copying compose files to the box…"
ssh $SSH_OPTS "$SSH_USER@$EIP" "mkdir -p /opt/vibevarium"
scp $SSH_OPTS -r "$INFRA_DIR/compose/" "$SSH_USER@$EIP:/opt/vibevarium/"

# Substitute DOMAIN in compose + Caddyfile, write .env
# CASDOOR_ADMIN_PASSWORD is generated once, persisted to AWS Secrets Manager,
# and reused on subsequent deploys (Casdoor only applies initAdminPassword on
# first database creation, so this is only effective on a fresh install).
echo ">>> Ensuring Casdoor admin password in Secrets Manager…"
CASDOOR_ADMIN_PASSWORD=$(aws secretsmanager get-secret-value \
  --secret-id /vibevarium/prod/casdoor-admin-password \
  --region "$AWS_REGION" --profile "$AWS_PROFILE" \
  --query 'SecretString' --output text 2>/dev/null || true)
if [ -z "$CASDOOR_ADMIN_PASSWORD" ]; then
  CASDOOR_ADMIN_PASSWORD=$(openssl rand -base64 24 | tr -d '=+/' | cut -c1-24)
  aws secretsmanager create-secret \
    --name /vibevarium/prod/casdoor-admin-password \
    --secret-string "$CASDOOR_ADMIN_PASSWORD" \
    --region "$AWS_REGION" --profile "$AWS_PROFILE" >/dev/null
  echo "  generated + stored new Casdoor admin password"
else
  echo "  reusing existing Casdoor admin password"
fi

ssh $SSH_OPTS "$SSH_USER@$EIP" bash -s <<REMOTE
set -euo pipefail
cd /opt/vibevarium/compose
sed -i "s/\\\${DOMAIN}/$TERRARIUM_DOMAIN/g" Caddyfile
cat > .env <<ENVEOF
DOMAIN=$TERRARIUM_DOMAIN
DB_HOST=$DB_ENDPOINT
DB_PORT=5432
DB_USER=$DB_USER
DB_PASSWORD=$DB_PASSWORD
CASDOOR_ADMIN_PASSWORD=$CASDOOR_ADMIN_PASSWORD
ENVEOF
chmod 600 .env
echo "Compose .env written"
REMOTE

# Build control-plane Dockerfile context on the box — full workspace needed
# because control-plane imports from sibling packages.
echo ">>> Copying workspace build context…"
cd "$REPO_ROOT"
tar czf /tmp/vibevarium-workspace.tgz \
  --exclude='node_modules' \
  --exclude='.alchemy' \
  --exclude='.git' \
  --exclude='dist' \
  --exclude='.data' \
  --exclude='.secrets' \
  --exclude='apps' \
  --exclude='.env' \
  --exclude='.env.*' \
  package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc \
  packages/
scp $SSH_OPTS /tmp/vibevarium-workspace.tgz "$SSH_USER@$EIP:/tmp/"
ssh $SSH_OPTS "$SSH_USER@$EIP" bash -s <<'REMOTE'
set -euo pipefail
mkdir -p /opt/vibevarium/compose/control-plane
cd /opt/vibevarium/compose/control-plane
tar xzf /tmp/vibevarium-workspace.tgz
rm /tmp/vibevarium-workspace.tgz
REMOTE

# ── 8. docker compose up ─────────────────────────────────────────────────
echo ">>> docker compose up…"
ssh $SSH_OPTS "$SSH_USER@$EIP" bash -s <<'REMOTE'
set -euo pipefail
cd /opt/vibevarium/compose
docker compose pull caddy casdoor
docker compose up -d --build
echo "=== Services ==="
docker compose ps
REMOTE

# ── 9. Verify ─────────────────────────────────────────────────────────────
echo
echo "=== Deploy complete ==="
echo "  Auth:     https://auth.$TERRARIUM_DOMAIN"
echo "  Platform: https://platform.$TERRARIUM_DOMAIN"
echo
echo "Verify:"
echo "  curl https://auth.$TERRARIUM_DOMAIN/api/.well-known/openid-configuration"
echo "  curl https://platform.$TERRARIUM_DOMAIN/health"
echo "  curl https://platform.$TERRARIUM_DOMAIN/config-check  # which config keys came from AWS SM (names only)"
