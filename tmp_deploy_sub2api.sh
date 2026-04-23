#!/bin/bash
set -e

echo "=== Step 1: Fix Docker daemon.json ==="
cat > /etc/docker/daemon.json << 'EOF'
{
  "registry-mirrors": [
    "https://docker.1ms.run",
    "https://docker.xuanyuan.me"
  ]
}
EOF

echo "daemon.json content:"
cat /etc/docker/daemon.json

echo "=== Step 2: Restart Docker ==="
systemctl restart docker
echo "Docker restarted successfully"

echo "=== Step 3: Start sub2api ==="
cd /root/sub2api-deploy
docker compose up -d

echo "=== Step 4: Check status ==="
sleep 5
docker compose ps

echo "=== Step 5: Get admin password ==="
docker compose logs sub2api 2>&1 | grep -i "admin\|password\|setup" | head -20

echo "=== DEPLOYMENT COMPLETE ==="
echo "Access sub2api at: http://154.12.88.124:8080"
