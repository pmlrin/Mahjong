#!/bin/bash
# New service install. Deliberately fails if a Mahjong service already exists.
set -euo pipefail
cd /opt/mahjong/releases/20261029-v1
if test -e /etc/systemd/system/mahjong.service; then echo 'Mahjong already installed; use the update procedure.'; exit 1; fi
if ! id mahjong >/dev/null 2>&1; then useradd --system --no-create-home --shell /sbin/nologin mahjong; fi
mkdir -p /opt/mahjong/runtime /opt/mahjong/backups /var/www/mahjong-acme
chmod 700 /opt/mahjong/backups
tar -xJf /opt/mahjong/node-linux-x64.tar.xz --strip-components=1 -C /opt/mahjong/runtime
/opt/mahjong/runtime/bin/node --version
python3 - <<'PY'
from pathlib import Path
import secrets
base=Path('/opt/mahjong');password=secrets.token_hex(32)
service=base/'service.env';db=base/'db.env'
if service.exists() or db.exists(): raise SystemExit('Refusing to overwrite existing secrets')
service.write_text('NODE_ENV=production\nHOST=127.0.0.1\nPORT=8029\nPUBLIC_ORIGIN=https://mahjong.yangjm.cn\nSESSION_SECRET='+secrets.token_hex(48)+'\nDATABASE_URL=postgres://mahjong:'+password+'@127.0.0.1:5433/mahjong\n')
db.write_text('POSTGRES_USER=mahjong\nPOSTGRES_DB=mahjong\nPOSTGRES_PASSWORD='+password+'\n')
service.chmod(0o600);db.chmod(0o600)
PY
docker run -d --name mahjong-db --restart unless-stopped --memory 160m --shm-size 64m --env-file /opt/mahjong/db.env -p 127.0.0.1:5433:5432 -v mahjong-data:/var/lib/postgresql/data postgres:17-bookworm postgres -c shared_buffers=32MB -c max_connections=20 -c work_mem=2MB
for attempt in $(seq 1 30); do if docker exec mahjong-db pg_isready -U mahjong -d mahjong; then break; fi; sleep 1; done
ln -s /opt/mahjong/releases/20261029-v1 /opt/mahjong/current
cp deploy/mahjong.service /etc/systemd/system/mahjong.service
systemctl daemon-reload
systemctl enable --now mahjong.service
for attempt in $(seq 1 20); do if curl --fail --silent http://127.0.0.1:8029/healthz; then break; fi; sleep 1; done
if test -e /etc/nginx/conf.d/mahjong.yangjm.cn.conf; then echo 'Refusing to overwrite an existing Nginx site'; exit 1; fi
cp deploy/nginx-http.conf /etc/nginx/conf.d/mahjong.yangjm.cn.conf
nginx -t
nginx -s reload
