#!/usr/bin/env bash
# Terrarium infrastructure deploy script.
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

echo "=== Terrarium infra deploy ==="
echo "  Domain:  $TERRARIUM_DOMAIN"
echo "  Zone:    $CLOUDFLARE_ZONE_ID"
echo "  Profile: $AWS_PROFILE"
echo "  Region:  $AWS_REGION"
echo

# ── 1. Deploy the stack ───────────────────────────────────────────────────
echo ">>> alchemy deploy…"
cd "$INFRA_DIR"
pnpm exec alchemy deploy --config ./src/main.ts

# ── 2. Read stack outputs + extract SSH key ───────────────────────────────
echo ">>> Reading stack outputs…"
STATE_DIR="$REPO_ROOT/.alchemy/state/TerrariumInfra/default"
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
SSH_KEY="$REPO_ROOT/.secrets/terrarium-key.pem"
jq -r '.sshPrivateKey // empty' "$OUTPUT_FILE" > "$SSH_KEY"
if [ ! -s "$SSH_KEY" ]; then
  # Fallback: read from the KeyPair resource state file directly
  KEY_STATE=$(find "$STATE_DIR" -name '*.json' ! -name '__stack_output__.json' -exec grep -l 'privateKey' {} \; | head -1)
  if [ -n "$KEY_STATE" ]; then
    jq -r '.attr.privateKey // .privateKey // empty' "$KEY_STATE" > "$SSH_KEY"
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

# ── 6. Create control_plane database (idempotent) ────────────────────────
echo ">>> Creating control_plane database on RDS (via EC2)…"
ssh $SSH_OPTS "$SSH_USER@$EIP" bash -s <<REMOTE
set -euo pipefail
export PGPASSWORD='$DB_PASSWORD'
psql -h "$DB_ENDPOINT" -U "$DB_USER" -d logto -tc \
  "SELECT 1 FROM pg_database WHERE datname='control_plane'" | grep -q 1 || \
psql -h "$DB_ENDPOINT" -U "$DB_USER" -d logto -c \
  "CREATE DATABASE control_plane"
echo "control_plane database ready"
REMOTE

# ── 7. Push compose + build context ───────────────────────────────────────
echo ">>> Copying compose files to the box…"
scp $SSH_OPTS -r "$INFRA_DIR/compose/" "$SSH_USER@$EIP:/opt/terrarium/"

# Substitute DOMAIN in compose + Caddyfile, write .env
ssh $SSH_OPTS "$SSH_USER@$EIP" bash -s <<REMOTE
set -euo pipefail
cd /opt/terrarium/compose
sed -i "s/\\\${DOMAIN}/$TERRARIUM_DOMAIN/g" Caddyfile
cat > .env <<ENVEOF
DOMAIN=$TERRARIUM_DOMAIN
DB_HOST=$DB_ENDPOINT
DB_PORT=5432
DB_USER=$DB_USER
DB_PASSWORD=$DB_PASSWORD
ENVEOF
echo "Compose .env written"
REMOTE

# Build control-plane Dockerfile context on the box — full workspace needed
# because control-plane imports from sibling packages.
echo ">>> Copying workspace build context…"
cd "$REPO_ROOT"
tar czf /tmp/terrarium-workspace.tgz \
  --exclude='node_modules' \
  --exclude='.alchemy' \
  --exclude='.git' \
  --exclude='dist' \
  --exclude='.data' \
  --exclude='.secrets' \
  --exclude='apps' \
  --exclude='.env' \
  --exclude='.env.*' \
  package.json pnpm-workspace.yaml pnpm-lock.yaml \
  packages/
scp $SSH_OPTS /tmp/terrarium-workspace.tgz "$SSH_USER@$EIP:/tmp/"
ssh $SSH_OPTS "$SSH_USER@$EIP" bash -s <<'REMOTE'
set -euo pipefail
mkdir -p /opt/terrarium/compose/control-plane
cd /opt/terrarium/compose/control-plane
tar xzf /tmp/terrarium-workspace.tgz
rm /tmp/terrarium-workspace.tgz
REMOTE

# ── 8. docker compose up ─────────────────────────────────────────────────
echo ">>> docker compose up…"
ssh $SSH_OPTS "$SSH_USER@$EIP" bash -s <<'REMOTE'
set -euo pipefail
cd /opt/terrarium/compose
docker compose pull caddy logto
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
