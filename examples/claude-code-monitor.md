# Using a monitor from a Claude Code session

One arm of the Monitor tool per session, against the hub, instead of one watch per thing.

1. Subscribe once (the token is shown once; keep it in the session, never in a file that is committed):

   ```bash
   curl -s http://127.0.0.1:8130/mp/v0/subscriptions -H 'Content-Type: application/json' \
     -d '{"monitor":"ci","subscriber":"agent:claude@ab12cd34","capabilities":["observe"]}'
   ```

2. Arm the Monitor tool with the watch loop. It prints the backlog first without acking, then one
   line per observation, acking after each line:

   ```
   Monitor(command: "npx -y @mentu/monitor-protocol watch --base http://127.0.0.1:8130 --subscription sub-… --token $TOKEN --catch-up")
   ```

   Lines look like `OBS seq=17 type=com.example.ci.run subject=build-412 tier=measured origin=probe actor=probe:ci redelivered=false data={"status":"failed"}`.

3. The Monitor tool expires after thirty minutes. Re-arm with `--catch-up`: the cursor was committed
   after each printed line, so nothing was lost, and the backlog shows what happened in the gap.

4. To act, subscribe with `capabilities: ["observe","act"]` and use `lease_claim` / `lease_complete`
   (REST, JSON-RPC, or the MCP tools) — one holder per subject, expiry returns it to the queue.

Why not a Monitor per thing: each arm costs a re-arm every half hour and keeps no state; the hub keeps
the cursor and the state, and a second session can subscribe to the same monitor with its own cursor.
