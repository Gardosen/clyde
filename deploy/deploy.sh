#!/usr/bin/env bash
# Kopiert Clyde per SSH auf den Server und startet den Stack dort.
#
#   deploy/deploy.sh user@server.example.com [-p SSH-PORT] [-d /opt/clyde] [-f zusatz-compose.yml]
#
# Braucht auf dem Server: Docker mit Compose-Plugin. Die Datei deploy/.env wird
# beim ersten Mal mit hochgeladen (oder mit neuem Token angelegt), danach bleibt
# die Server-Kopie unangetastet.
set -euo pipefail

TARGET="${1:?Aufruf: deploy/deploy.sh user@host [-p port] [-d remote-dir] [-f zusatz-compose]}"
shift
PORT=22
REMOTE_DIR=/opt/clyde
EXTRA=""
while getopts "p:d:f:" o; do
  case $o in
    p) PORT=$OPTARG ;;
    d) REMOTE_DIR=$OPTARG ;;
    f) EXTRA="-f $OPTARG" ;;
    *) exit 2 ;;
  esac
done

cd "$(dirname "$0")/.."
SSH="ssh -p $PORT $TARGET"

echo "Lade Code nach $TARGET:$REMOTE_DIR ..."
tar --exclude=node_modules --exclude=.git --exclude=.env --exclude=deploy/.env \
    -czf - package.json README.md src server bin test deploy \
  | $SSH "mkdir -p '$REMOTE_DIR' && tar -xzf - -C '$REMOTE_DIR'"

if ! $SSH "test -f '$REMOTE_DIR/deploy/.env'"; then
  if [ ! -f deploy/.env ]; then
    echo "Keine deploy/.env vorhanden, lege eine mit neuem Token an ..."
    TOKEN=$(node -e "console.log(require('crypto').randomBytes(24).toString('hex'))" 2>/dev/null || openssl rand -hex 24)
    sed "s/^CLYDE_TOKEN=.*/CLYDE_TOKEN=$TOKEN/" deploy/.env.example > deploy/.env
    echo "Token: $TOKEN (steht in deploy/.env; denselben Token bei 'clyde init --token' angeben)"
  fi
  echo "Kopiere deploy/.env auf den Server ..."
  $SSH "cat > '$REMOTE_DIR/deploy/.env'" < deploy/.env
fi

echo "Starte Stack ..."
$SSH "cd '$REMOTE_DIR/deploy' && docker compose -f docker-compose.yml $EXTRA up -d --build && docker compose -f docker-compose.yml $EXTRA ps"

DOMAIN=$(grep '^CLYDE_DOMAIN=' deploy/.env | cut -d= -f2)
echo "Fertig. Test von aussen:  curl https://${DOMAIN:-DEINE-DOMAIN}/health"
