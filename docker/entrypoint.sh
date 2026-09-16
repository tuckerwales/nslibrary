#!/bin/sh
set -e

uid="${PUID:-1000}"
gid="${PGID:-1000}"

mkdir -p /data

if [ "$(id -u)" = "0" ]; then
  groupmod -o -g "$gid" node
  usermod -o -u "$uid" -g "$gid" -d /data node
  chown -R "$uid:$gid" /data
  exec gosu node "$@"
fi

exec "$@"
