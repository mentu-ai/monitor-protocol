#!/usr/bin/env bash
# End-to-end over the REST binding against a local server: create → publish → subscribe → pull → ack → lease.
# Usage: npx @mentu/monitor-protocol serve --port 8130 &   then   bash examples/curl-walkthrough.sh
set -euo pipefail
B="${BASE:-http://127.0.0.1:8130}/mp/v0"
j() { python3 -c "import json,sys; d=json.load(sys.stdin); print(eval('d'+sys.argv[1]))" "$1"; }

echo "# discover"; curl -s "$B/discover" | j "['supportedVersions']"
M=$(curl -s "$B/monitors" -H 'Content-Type: application/json' -d '{"id":"ci","name":"CI watch","horizon":"minute","capabilities":["observe","act"],"visibility":"public","types":["com.example.ci.run"]}')
OWNER=$(echo "$M" | j "['owner_token']")
echo "# publish (probe, measured)"; curl -s "$B/monitors/ci/observations" -H "Authorization: Bearer $OWNER" -H 'Content-Type: application/json' \
  -d '{"type":"com.example.ci.run","subject":"build-412","tier":"measured","origin":"probe","data":{"status":"failed"}}' | j "['observation']['sequence']"
echo "# an agent asserting src is refused, and the refusal is an observation"
curl -s "$B/monitors/ci/observations" -H "Authorization: Bearer $OWNER" -H 'Content-Type: application/json' \
  -d '{"type":"com.example.ci.run","subject":"build-413","tier":"src","origin":"agent","data":{}}' | j "['code']"
S=$(curl -s "$B/subscriptions" -H 'Content-Type: application/json' -d '{"monitor":"ci","subscriber":"agent:claude@ab12cd34","capabilities":["observe","act"]}')
SID=$(echo "$S" | j "['subscription']['id']"); TOK=$(echo "$S" | j "['token']")
echo "# pull (does not advance the cursor)"; P=$(curl -s "$B/subscriptions/$SID/pull?limit=10" -H "Authorization: Bearer $TOK"); echo "$P" | j "['head']"
NEXT=$(echo "$P" | j "['next']")
echo "# ack after processing"; curl -s "$B/subscriptions/$SID/ack" -H "Authorization: Bearer $TOK" -H 'Content-Type: application/json' -d "{\"cursor\":$NEXT}" | j "['cursor']"
echo "# lease a subject, complete it with evidence"
curl -s "$B/subscriptions/$SID/leases/claim" -H "Authorization: Bearer $TOK" -H 'Content-Type: application/json' -d '{"subject":"build-412","lease_duration_seconds":600}' | j "['lease']['holder']"
curl -s "$B/subscriptions/$SID/leases/complete" -H "Authorization: Bearer $TOK" -H 'Content-Type: application/json' -d '{"subject":"build-412","outcome":"retried","evidence":[{"source":"monitor:ci","id":"1"}]}' | j "['ok']"
echo "# state: gaps are properties, confidence is null until every input exists"
curl -s "$B/monitors/ci/state" | j "['confidence']"
