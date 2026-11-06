#!/usr/bin/env bash
# Nightly todone database backup on the VPS (cron: /etc/cron.d/todone-backup). See contributing-docs/vps.md.
#   1. pg_dump to /root/todone-backups (14 days kept on the machine)
#   2. if backup.age-recipient exists: encrypt to that age public key and copy to R2 (rclone remote "r2"),
#      keeping dailies 15 days and the 1st of each month for a year. Only the owner's private key can open them.
#   3. Sundays (or with --test): restore into a throwaway Postgres and compare row counts.
#   4. report ok/error to Sentry Crons (SENTRY_DSN in .env), which alerts on a failed or missed night.
set -euo pipefail
cd "$(dirname "$0")/.."
DIR=/root/todone-backups
DAY=$(date +%F)
FILE="$DIR/todone-$DAY.dump"
DSN=$(sed -n 's/^SENTRY_DSN=//p' .env)
RECIPIENT=$(cat backup.age-recipient 2>/dev/null || true)

checkin() {
  [ -n "$DSN" ] || return 0
  local key=${DSN#https://} host=${DSN#*@} project=${DSN##*/}
  key=${key%%@*} host=${host%%/*}
  curl -fsS -m 20 -X POST -H 'content-type: application/json' \
    -d "{\"status\":\"$1\",\"monitor_config\":{\"schedule\":{\"type\":\"crontab\",\"value\":\"17 3 * * *\"},\"checkin_margin\":60,\"max_runtime\":60,\"timezone\":\"$(cat /etc/timezone 2>/dev/null || echo UTC)\"}}" \
    "https://$host/api/$project/cron/todone-backup/$key/" >/dev/null || true
}
trap 'checkin error' ERR

mkdir -p "$DIR" && chmod 700 "$DIR"
docker compose -p todone exec -T db pg_dump -U todone -Fc todone > "$FILE.tmp"
mv "$FILE.tmp" "$FILE"
find "$DIR" -name 'todone-*.dump' -mtime +14 -delete
echo "$(date -Is) dumped $(du -h "$FILE" | cut -f1)"

if [ -n "$RECIPIENT" ]; then
  age -r "$RECIPIENT" -o "$FILE.age" "$FILE"
  rclone copyto "$FILE.age" "r2:todone-backups/daily/todone-$DAY.dump.age"
  if [ "$(date +%d)" = 01 ]; then rclone copyto "$FILE.age" "r2:todone-backups/monthly/todone-$DAY.dump.age"; fi
  rm "$FILE.age"
  rclone delete --min-age 15d r2:todone-backups/daily
  rclone delete --min-age 366d r2:todone-backups/monthly
  echo "$(date -Is) uploaded to R2"
fi

if [ "$(date +%u)" = 7 ] || [ "${1:-}" = --test ]; then
  c=todone-restore-test
  docker rm -f $c >/dev/null 2>&1 || true
  docker run -d --name $c -e POSTGRES_USER=todone -e POSTGRES_PASSWORD=test -e POSTGRES_DB=todone postgres:17-alpine >/dev/null
  # The image starts Postgres twice (once to initialise); the second "ready" is the real one.
  until [ "$(docker logs $c 2>&1 | grep -c 'ready to accept connections')" -ge 2 ]; do sleep 1; done
  docker exec -i $c pg_restore -U todone -d todone --no-owner < "$FILE"
  # ponytail: counts are read a moment after the dump, so a sign-up in between gives one false alarm.
  q='select (select count(*) from "user") || '"'/'"' || (select count(*) from list)'
  live=$(docker compose -p todone exec -T db psql -U todone -d todone -tAc "$q")
  copy=$(docker exec $c psql -U todone -d todone -tAc "$q")
  docker rm -f $c >/dev/null
  if [ "$live" != "$copy" ]; then echo "restore test failed: live $live users/lists, backup $copy"; false; fi
  echo "$(date -Is) restore test ok ($copy users/lists)"
fi

checkin ok
