#!/bin/sh
set -e

uid="${PUID:-1000}"
gid="${PGID:-1000}"

mkdir -p /data

if [ "$(id -u)" = "0" ]; then
  groupmod -o -g "$gid" node
  usermod -o -u "$uid" -g "$gid" -d /data node
  # Only walk the whole volume when it does not already belong to this user, since the icon cache
  # can hold thousands of files.
  if [ "$(stat -c %u /data)" = "$uid" ] && [ "$(stat -c %g /data)" = "$gid" ]; then
    chown "$uid:$gid" /data
  else
    chown -R "$uid:$gid" /data
  fi
  exec gosu node "$@"
fi

exec "$@"
