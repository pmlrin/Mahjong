#!/bin/bash
set -euo pipefail
umask 077
mkdir -p /opt/mahjong/backups
backup_path=/opt/mahjong/backups/mahjong-$(date -u +%Y%m%dT%H%M%SZ).dump
docker exec mahjong-db pg_dump -U mahjong -d mahjong --format=custom > "$backup_path"
test -s "$backup_path"
echo "Backup completed: $backup_path"
