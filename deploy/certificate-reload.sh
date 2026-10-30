#!/bin/sh
# Install as /etc/letsencrypt/renewal-hooks/deploy/mahjong-nginx-reload.sh
if [ "$RENEWED_LINEAGE" = /etc/letsencrypt/live/mahjong.yangjm.cn ]; then
  /usr/sbin/nginx -t && /usr/sbin/nginx -s reload
fi
