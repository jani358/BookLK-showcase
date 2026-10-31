# BookLK runbook

What to do when an alert fires or something looks wrong. SLO definitions: [SLO.md](SLO.md).
Commands assume the k3d lab (`kubectl -n booklk ...`); in compose use `docker compose logs`.

**First five minutes, any alert:**
1. Open Grafana, dashboard **BookLK overview** (`kubectl -n booklk port-forward svc/booklk-grafana 3180:3000`).
2. `kubectl -n booklk get pods` for restarts, `Pending` or `CrashLoopBackOff`.
3. What changed? `kubectl -n argocd get applications` and the last commits on `main`
   (ArgoCD deploys whatever `main` says). A deploy in the last hour is the first suspect.
4. If a deploy is the cause: **roll back first, debug later.** `git revert` the bump
   commit and push; ArgoCD rolls back. (`kubectl rollout undo` also works, but ArgoCD's
   self-heal will put the bad version back unless Git changes.)

---

## Booking API 5xx

Alert: `BookingApiErrorBudgetBurn` / `BookingApiErrorBudgetBurnSlow`.

1. `kubectl -n booklk logs deploy/booklk-api --since=15m | grep -i error`. Sentry, if a DSN
   is configured, groups the same errors with stack traces.
2. `kubectl -n booklk get pods -l app.kubernetes.io/name=postgres` and the API's
   `/health` (`kubectl -n booklk exec deploy/booklk-api -- wget -qO- localhost:3001/health`).
   `postgres:false` means the database: check its pod, disk (`df` inside it) and connections.
3. Redis down does **not** break booking correctness (the Redis lock is only an
   optimisation; the row lock and the UNIQUE index are the guarantee), but `/health`
   reports it and readiness takes pods out of rotation. Bring Redis back first.
4. Many `P2034` (write conflict / deadlock) errors in the logs under load. The booking
   transaction runs at READ COMMITTED since the k6 spike, so it should produce none; the
   remaining Serializable path is the payment webhook gate. They map to 409, not 5xx; if
   they show up as 5xx, that is a bug in the error filter.

## Booking API slow

Alert: `BookingApiLatencyP95High`.

1. Is it everything or only bookings? Dashboard panel "API requests by route".
2. Postgres: `SELECT state, wait_event_type, count(*) FROM pg_stat_activity GROUP BY 1,2;`
   Lots of `Lock` waits means hot-slot contention; lots of `idle in transaction` means a
   leaked transaction.
3. API pods at their CPU limit (`kubectl top pods -n booklk`)? Scale up:
   change `api.replicas` in Git (ArgoCD applies it), not with `kubectl scale`.
4. Re-run the k6 spike (`load/booking-spike.js`) against a copy and compare.

## Outbox backlog

Alert: `OutboxBacklogStuck`. Effects: notifications, read models and live updates are
delayed; **bookings and payments still work** (they only write to the outbox).

1. `kubectl -n booklk get pods -l app.kubernetes.io/name=relay` and its logs.
2. Redpanda healthy? `kubectl -n booklk exec sts/booklk-redpanda -- rpk cluster health`.
3. `SELECT id, type, attempts, "lastError" FROM "OutboxEvent" WHERE "publishedAt" IS NULL ORDER BY seq LIMIT 20;`
   One row with many attempts blocks its aggregate (head-of-line ordering by design):
   fix the cause (usually a message too large or a topic that does not exist).
4. Restarting the relay is always safe: rows are claimed with `FOR UPDATE SKIP LOCKED`
   and consumers dedupe on `eventId`.

## Realtime lag

Alert: `RealtimeKafkaLagHigh`. Browsers see slot changes late; booking itself is unaffected.

1. CPU of the realtime pods; the HPA should be adding pods (`kubectl -n booklk get hpa`).
2. `booklk_realtime_messages_dropped_total` rising means slow clients, not Kafka.
3. Each hub pod is its own consumer group; a restarted pod starts at the latest offset by
   design (it only needs current state).

## Payment failures

Alert: `PaymentFailureRateHigh`.

1. Which provider? `SELECT provider, status, count(*) FROM "Payment" WHERE "createdAt" > now() - interval '1 hour' GROUP BY 1,2;`
2. Provider status pages (Stripe, PayHere). Sandbox outages happen.
3. Webhooks arriving? `SELECT provider, count(*) FROM "InboundWebhook" WHERE "receivedAt" > now() - interval '1 hour' GROUP BY 1;`
   If not, the nightly reconciliation will flag missing webhooks; the admin "heal" endpoint
   re-applies the provider's record.

## Disk full (Docker host or a node)

See the [2026-10-30 postmortem](postmortems/2026-10-30-docker-disk-full.md).

1. `docker system df`, then `docker builder prune -f` (build cache is usually the biggest
   and is always safe to drop).
2. Images built for k3d can be deleted after `k3d image import`.
3. Never prune volumes without checking what they belong to.
