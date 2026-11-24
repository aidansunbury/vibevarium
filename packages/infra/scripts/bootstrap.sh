#!/usr/bin/env bash
# EC2 user-data: installs Docker, docker-compose plugin, AWS CLI, and psql.
# The compose stack itself is pushed to the box by scripts/deploy.sh.
set -euo pipefail
exec > >(tee -a /var/log/vibevarium-bootstrap.log) 2>&1

echo "=== Vibevarium bootstrap $(date -Is) ==="

export DEBIAN_FRONTEND=noninteractive

# Docker
apt-get update -y
apt-get install -y ca-certificates curl gnupg lsb-release unzip postgresql-client
install -m 0755 -d /etc/apt/keyrings
if [ ! -f /etc/apt/keyrings/docker.gpg ]; then
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  chmod a+r /etc/apt/keyrings/docker.gpg
fi
echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu \
  $(lsb_release -cs) stable" > /etc/apt/sources.list.d/docker.list
apt-get update -y
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

# AWS CLI v2 (needed to read the RDS master secret + associate the EIP)
if ! command -v aws >/dev/null 2>&1; then
  curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o /tmp/awscliv2.zip
  unzip -q /tmp/awscliv2.zip -d /tmp
  /tmp/aws/install
  rm -rf /tmp/aws /tmp/awscliv2.zip
fi

# Let the default ubuntu user run docker without sudo
usermod -aG docker ubuntu || true

# Working directory for the compose stack
mkdir -p /opt/vibevarium
chown ubuntu:ubuntu /opt/vibevarium

systemctl enable docker
systemctl start docker

echo "=== Bootstrap complete $(date -Is) ==="
