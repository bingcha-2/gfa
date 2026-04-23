#!/bin/bash
echo "=== Step 1: Backup ==="
cd /opt/newapi
cp docker-compose.yml docker-compose.yml.bak
docker exec postgres pg_dump -U root new-api > /opt/newapi/db_backup.sql
echo "DB backup done"
echo "=== Step 2: Pull latest ==="
docker pull calciumion/new-api:latest
echo "=== Step 3: Restart ==="
cd /opt/newapi && docker compose down new-api && docker compose up -d new-api
echo "=== Step 4: Wait for healthy ==="
sleep 8
docker ps --filter name=new-api --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}'
echo "=== Done ==="
