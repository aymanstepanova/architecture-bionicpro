#!/bin/sh
# Регистрация Debezium Postgres Connector для CRM.
# Запускать после старта kafka-connect (например: docker compose up -d kafka-connect && sleep 15 && ./debezium/register-connector.sh)

CONNECT_URL="${KAFKA_CONNECT_URL:-http://localhost:8083}"
CONFIG_FILE="$(dirname "$0")/postgres-crm-connector.json"

echo "Registering connector from $CONFIG_FILE to $CONNECT_URL"
curl -s -X POST -H "Content-Type: application/json" \
  --data @"$CONFIG_FILE" \
  "$CONNECT_URL/connectors" | head -20
