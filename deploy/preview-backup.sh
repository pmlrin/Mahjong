#!/bin/bash
set -euo pipefail
umask 077
mkdir -p /opt/mahjong/v2-preview-backups
backup_path=/opt/mahjong/v2-preview-backups/preview-$(date -u +%Y%m%dT%H%M%SZ).dump
docker exec mahjong-db pg_dump -U mahjong -d mahjong_v2_preview_20261029 --format=custom > "$backup_path"
test -s "$backup_path"
echo "Preview backup completed: $backup_path"
