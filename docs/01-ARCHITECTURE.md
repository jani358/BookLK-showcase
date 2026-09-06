# 01 — Architecture

BookLK is a multi-vendor service booking marketplace. Customers book time slots with
vendors (salons, clinics, repair shops); vendors publish services and availability; the
platform takes a commission on every booking and pays vendors out.

This document explains what each piece is, why it exists, and what was rejected.

---

## 1. System overview

```
                              ┌──────────────────────────┐
                              │        Browser           │
                              │  Next.js 14 App Router   │
                              │  (SSG · SSR · CSR · PWA) │
                              └───┬──────────────────┬───┘
                    HTTPS / JSON  │                  │  WSS
                                  │                  │
              ┌───────────────────▼──────┐    ┌──────▼─────────────────┐
              │      apps/api            │    │    apps/realtime       │
              │      NestJS 10           │    │    Go 1.26             │
              │                          │    │                        │
              │  auth · vendors          │    │  WebSocket hub         │
              │  services · slots        │    │  goroutine per conn    │
              │  bookings · payments     │    │  bounded worker pool   │
              │  reviews · health        │    │  heartbeat ping/pong   │
              │  Swagger /docs           │    │  /health  /metrics     │
              └────┬──────────────┬──────┘    └──────────┬─────────────┘
                   │              │                      │
     Prisma / SQL  │              │ ioredis              │ go-redis
                   │              │                      │
        ┌──────────▼───────┐   ┌──▼──────────────────────▼─────────────┐
        │  PostgreSQL 16   │   │             Redis 7                   │
        │                  │   │                                       │
        │  users, vendors  │   │  slot short-locks (SET NX PX)         │
        │  services, slots │   │  sliding-window rate limit counters   │
        │  bookings        │   │  refresh-token / session side data    │
        │  payments        │   │  pub/sub channel  booklk:slots        │
        │  ledger_entries  │   │  read-through cache for hot queries   │
        │  reviews         │   └───────────────────────────────────────┘
        │  refresh_tokens  │
        └──────────────────┘

        Observability:  Sentry (errors) · Prometheus scrape → Grafana (metrics)
        Delivery:       Docker Compose (local) · GitHub Actions → registry → K8s / VPS
```

The write path and the fan-out path are deliberately separated. **The API owns all state
changes. The realtime service owns none.** The realtime service never writes to Postgres;
it is a read-only broadcaster. That single rule is what keeps the split honest, and it is
the first thing to say when someone asks why there are two backend services.

---

## 2. The services, and why each one exists

### apps/api — NestJS + TypeScript + Prisma + PostgreSQL + Redis

The system of record. Everything that changes state goes through here.

| Module | Responsibility | Why it is its own module |
|---|---|---|
| `auth` | Register, login, refresh rotation, RBAC guards | Security surface concentrated in one reviewable place |
| `vendors` | Vendor profile, onboarding, working hours | Tenant root — nearly every other row hangs off `vendor_id` |
| `services` | What a vendor sells: name, duration, price | Price and duration drive slot generation and money maths |
| `slots` | Availability generation and the slot state machine | The contended resource; concurrency lives here |
| `bookings` | Reserve a slot, cancel, the transaction boundary | The one place double-booking can happen |
| `payments` | Mock provider, webhooks, ledger, payout queue | Money code should be isolated and heavily tested |
| `reviews` | Post-completion ratings | Different consistency needs from bookings |
| `health` | Liveness/readiness with dependency checks | Kubernetes and load balancers need a real answer |

NestJS gives module boundaries, dependency injection, guards/interceptors/pipes as
first-class concepts, and decorator-driven Swagger. On a project whose selling point is
that the structure is defensible, an opinionated framework is an asset: the shape of the
code is the same shape you draw on a whiteboard.

### apps/realtime — Go

One job: hold tens of thousands of idle WebSocket connections and push slot changes to
whoever is watching.

Why not just add a NestJS WebSocket gateway and delete this service? Because the
workloads are genuinely different:

- A booking request is short-lived, CPU-light, IO-bound, and needs a transaction.
- A WebSocket connection is long-lived, mostly idle, and costs memory, not CPU.

Node holds idle sockets fine, but every connection's callbacks share one event loop with
the request handlers. A slow JSON serialisation in the fan-out path adds latency to
booking requests. Go's scheduler gives each connection its own goroutine (a few KB of
stack, multiplexed onto OS threads) and the runtime preempts them, so one heavy consumer
does not stall the others. Deploy sizing also decouples: a traffic spike on bookings
means "more API pods"; a marketing push that has people staring at an availability page
means "more realtime pods".

The honest secondary reason: this project exists partly to demonstrate Go concurrency
competence. That is a legitimate reason to pick a stack in a portfolio project, and
saying so plainly in an interview reads better than inventing a performance story.

### apps/web — Next.js 14 App Router

One frontend, three rendering strategies chosen per page by what the page actually needs:

| Page | Strategy | Why |
|---|---|---|
| Landing, category pages | SSG | Content changes rarely, SEO matters, cache at the CDN edge |
| Vendor detail / listing | SSR | Needs fresh availability at load, still must be crawlable |
| Customer + vendor dashboards | CSR | Behind auth, no SEO value, highly interactive |

State is split on the same principle. **TanStack Query owns server state** (bookings,
slots, vendors — data that lives elsewhere and can go stale). **Zustand owns client
state** (booking wizard step, filter panel open, selected slot before submit — data that
has no server truth). The common mistake this avoids is putting server data in a global
store and then hand-writing cache invalidation, refetch-on-focus, and retry logic that
TanStack Query already implements.

Auth in the browser: the access token is held **in memory only** (a module variable, not
`localStorage`) and the refresh token lives in an `httpOnly` cookie the JS cannot read.
XSS therefore cannot exfiltrate a long-lived credential; the worst it can steal is a
token that dies in 15 minutes. See `03-SECURITY.md`.

### Infrastructure

- **PostgreSQL 16** — bookings, money, users. Anything needing transactions or joins.
- **Redis 7** — short slot locks, rate-limit counters, pub/sub fan-out, hot-query cache.
- **Docker Compose** for local dev, Dockerfiles per service, GitHub Actions for CI/CD,
  Kubernetes manifests for the production target, Sentry + Prometheus/Grafana for
  operations.

---

## 3. Request lifecycle — a booking, click to confirmed

The single most likely thing you will be asked to walk through. Follow the numbers.

```
 Browser                API (NestJS)             Redis            Postgres        Realtime
    │                        │                     │                  │              │
 1  │ POST /bookings ───────►│                     │                  │              │
    │  Idempotency-Key: k    │                     │                  │              │
    │  Bearer <access JWT>   │                     │                  │              │
    │                        │                     │                  │              │
 2  │              JwtAuthGuard: verify sig, exp   │                  │              │
 3  │              RolesGuard: role == customer    │                  │              │
 4  │              ValidationPipe: DTO + whitelist │                  │              │
 5  │              RateLimitGuard ────────────────►│ INCR window key  │              │
    │                        │◄──── count ok ──────│                  │              │
 6  │              Idempotency: SETNX idem:k ─────►│                  │              │
    │                        │  already exists? ──► return stored response, STOP     │
 7  │              Slot lock: SET lock:slot:<id> NX PX 10000          │              │
    │                        │  not acquired? ────► 409 slot busy, STOP              │
    │                        │                     │                  │              │
 8  │              BEGIN ISOLATION LEVEL SERIALIZABLE ───────────────►│              │
 9  │              SELECT * FROM slots WHERE id=$1 FOR UPDATE ───────►│              │
10  │              status must be FREE, else ROLLBACK → 409           │              │
11  │              UPDATE slots SET status='BOOKED' ─────────────────►│              │
12  │              INSERT INTO bookings (... slot_id UNIQUE) ────────►│              │
13  │              INSERT payment PENDING + ledger rows ─────────────►│              │
14  │              COMMIT ──────────────────────────────────────────►│              │
    │                        │                     │                  │              │
15  │              Store response under idem:k ───►│                  │              │
16  │              PUBLISH booklk:slots {...} ────►│──── fan-out ────────────────────►│
17  │◄─ 201 Created ─────────│                     │                  │              │
    │                        │                     │                  │   push to all
18  │◄══════════ WS: {type:"slot.updated", status:"BOOKED"} ══════════════ watchers ═╡
    │                        │                     │                  │              │
19  │  Release slot lock (DEL) — or let the 10s TTL expire            │              │
```

Points worth narrating out loud:

- **Steps 7 and 9 are two different locks, on purpose.** The Redis lock is a cheap
  first-line filter that rejects the 49 losers of a 50-way race before they ever touch a
  database connection. It is *not* the correctness guarantee — Redis locks can be lost to
  network partitions and clock skew. The `SELECT ... FOR UPDATE` inside the Serializable
  transaction is the correctness guarantee, and the `UNIQUE` constraint on
  `bookings.slot_id` is the last line of defence that turns any remaining bug into a
  constraint violation instead of a double-booked customer.
- **Step 16 happens after COMMIT, never before.** Publishing inside the transaction would
  broadcast a booking that could still roll back. The cost of publishing after commit is
  that a crash between 14 and 16 loses the notification — acceptable, because the next
  page load reads true state from Postgres. Choosing "possible missed notification" over
  "possible false notification" is the right trade for this domain.
- **Step 6 makes the whole endpoint safe to retry.** A mobile client that times out at
  step 14 and retries gets the stored 201, not a second booking.

---

## 4. Data flow for realtime updates

```
apps/api                    Redis                      apps/realtime               Browser
   │                          │                              │                        │
   │  after COMMIT            │                              │                        │
   │  PUBLISH booklk:slots ──►│                              │                        │
   │  {slotId, vendorId,      │──── subscriber delivery ────►│                        │
   │   status, version, ts}   │                              │                        │
   │                          │                     ┌────────▼─────────┐              │
   │                          │                     │ subscribe loop   │              │
   │                          │                     │ (one goroutine)  │              │
   │                          │                     └────────┬─────────┘              │
   │                          │                              │ enqueue                │
   │                          │                     ┌────────▼─────────┐              │
   │                          │                     │ bounded worker   │  queue full → │
   │                          │                     │ pool (N=16)      │  drop + count │
   │                          │                     └────────┬─────────┘              │
   │                          │                              │ hub.Broadcast(vendorId)│
   │                          │                     ┌────────▼─────────┐              │
   │                          │                     │ hub: room →      │              │
   │                          │                     │ []*Client        │              │
   │                          │                     └────────┬─────────┘              │
   │                          │                              │ client.send <- msg     │
   │                          │                     ┌────────▼─────────┐              │
   │                          │                     │ writePump per    │══ WS frame ══►│
   │                          │                     │ client (buffered)│              │
   │                          │                     └──────────────────┘              │
   │                          │                                                       │
   │                                              queryClient.setQueryData(['slots']) ◄┘
```

Design points:

- **Redis pub/sub, not in-process events.** With three API pods and four realtime pods,
  the pod that commits the booking is almost never the pod holding the watcher's socket.
  Pub/sub decouples them: any API instance can reach any connection on any realtime
  instance.
- **Bounded worker pool, not `go func()` per message.** An unbounded spawn turns a Redis
  message burst into an OOM. A bounded pool with a bounded queue converts overload into
  *dropped messages plus a metric*, which is a survivable degradation — the UI is stale
  for a few seconds and self-heals on the next fetch.
- **Per-client buffered send channel with a slow-consumer policy.** If a client's buffer
  (`SEND_BUFFER_SIZE`, default 256) fills, that client is closed rather than allowed to
  block the hub. One phone on a bad connection must not stall broadcasts to everyone else.
- **The frontend patches the cache, it does not refetch.** The WS hook calls
  `queryClient.setQueryData` for the affected slot. Refetching the whole availability
  list on every message would turn one booking into a thundering herd of HTTP requests
  from every watcher — exactly the load the WebSocket was meant to remove.
- **At-most-once delivery, and that is fine.** Pub/sub has no persistence; a realtime pod
  restarting misses messages. Because Postgres is the source of truth and the client
  refetches on reconnect and on window focus, the worst case is a few seconds of stale
  UI. Paying for guaranteed delivery (a log-based broker) to protect a *cache hint* would
  be the wrong trade.

---

## 5. Why three services instead of a monolith

The honest answer has two halves, and giving both is what makes it credible.

**The case for the split as built:**

| Reason | Substance |
|---|---|
| Different resource profiles | Idle WebSockets cost memory; bookings cost DB connections and CPU. Scaling them together wastes one to satisfy the other. |
| Failure isolation | A panic in a connection handler must not take down payment processing. Separate processes make that structural rather than a matter of care. |
| Independent deploy cadence | Frontend ships several times a day; the money path ships rarely and carefully. |
| Right tool per job | Go for many idle connections, NestJS/Prisma for transactional business logic, Next.js for a rendering-flexible UI. |

**When a monolith would have been the better call — and mostly is:**

At BookLK's actual current scale (a handful of vendors, no real traffic), a single NestJS
app with a WebSocket gateway would be strictly better. The distributed version buys costs
you pay from day one:

- Three deploy pipelines, three Dockerfiles, three health checks, three log streams.
- A shared `JWT_SECRET` that two codebases in two languages must agree on — a real class
  of "works locally, 401s in prod" bugs.
- No cross-service transaction. The publish-after-commit gap in §3 simply does not exist
  in a monolith.
- Local development needs everything running to test anything end to end.
- Debugging a booking now spans two languages and a message bus.

The rule I would actually apply on a commercial team: **start as a modular monolith with
clean module boundaries, and extract a service only when a specific, measured pressure
demands it** — this component needs to scale differently, or needs a different runtime,
or its failures are hurting an unrelated feature. BookLK extracted the realtime service
*before* that pressure arrived, and the deciding factor was demonstrating the skill, not
a production bottleneck. The module boundaries inside `apps/api` are drawn so that
extraction stays cheap if pressure ever does arrive — which is the part of the design I
would defend on a real team.

---

## 6. Technology choice rationale

| Choice | Why | What it costs / what was rejected |
|---|---|---|
| **NestJS** over Express | DI, module boundaries, guards/pipes/interceptors, decorator-driven Swagger. Structure that survives a growing team. | Heavier and more opinionated; decorators and DI are a real learning curve. **Rejected:** bare Express (structure becomes a matter of discipline), Fastify (faster, thinner ecosystem for this), Spring Boot (right for a Java shop, wrong for a TS-first stack). |
| **TypeScript** across JS-land | One language for API and web; Prisma generates types from the schema so a column rename fails at compile time. | Build step, occasional type gymnastics. |
| **Prisma** over TypeORM/Knex | Schema-first with a real migration workflow, generated types, readable queries. `$transaction` with an explicit isolation level covers the booking path. | Less control over exotic SQL — raw SQL is used deliberately for `SELECT ... FOR UPDATE`. **Rejected:** TypeORM (entity/migration drift), raw `pg` (fast, but hand-maintained types). |
| **Go** for realtime | Goroutine per connection at a few KB each; the runtime preempts, so one bad consumer cannot stall others; static binary in a tiny container; `defer`/`recover` gives per-goroutine crash containment. | A second language, second toolchain, second CI job. **Rejected:** Node WS gateway (shares the event loop with bookings), Elixir/Phoenix (arguably better at this, but a third language nobody on the team reads), managed Pusher/Ably (removes the interesting engineering, adds per-message cost). |
| **PostgreSQL** for the core | Bookings and money need ACID, row locks, `SERIALIZABLE`, unique constraints, and joins. The double-booking guarantee is *built from* Postgres primitives. | Vertical-scaling-first; sharding is a project. **Rejected:** MySQL (fine, weaker constraint/type story), any document store for bookings (no multi-row transactional guarantee = the exact bug we are preventing). |
| **MongoDB** for reviews / activity logs | Review documents are shape-flexible (photos, vendor replies, moderation flags), append-heavy, never join against money rows, and tolerate eventual consistency. | A second database to operate, back up, and monitor. **This is the weakest justification in the stack, and I would say so in an interview:** Postgres `JSONB` would serve reviews well and remove an entire dependency. Mongo is here because polyglot persistence with a *stated* boundary — transactional core in Postgres, flexible non-transactional content in Mongo — is a defensible pattern, not because reviews outgrew Postgres. |
| **Redis** for locks, limits, cache, pub/sub | Single-threaded atomic ops make `SET NX PX` a correct short lock; sliding-window counters are cheap; pub/sub gives cross-instance fan-out; TTLs make expiry free. | Not durable — anything in Redis must be reconstructible from Postgres. Redis locks are an optimisation, never the correctness guarantee. |
| **Kafka-style events** (`booking.created`, `payment.succeeded`) | Booking completion has a growing tail of side effects: notify customer, notify vendor, queue the payout, update analytics, warm search. Doing them inline makes booking slower and couples its success to an email provider's uptime. An append-only log gives durable, replayable, independently-consumable events. | Real operational weight (brokers, consumer groups, lag monitoring, at-least-once so every consumer must be idempotent). **Honest position:** at current scale Redis Streams or BullMQ delivers 90% of the value at 10% of the cost, and that is what a real team should start with. Kafka's advantage is replay — a new analytics consumer can rebuild from the beginning of the log — and *that* is the argument that justifies it later, not throughput. |
| **Next.js App Router** | Per-page SSG/SSR/CSR, file routing, image optimisation, one deployable frontend. | The server/client component split is genuinely confusing at first; `"use client"` boundaries need care. **Rejected:** plain React SPA (no SEO for vendor pages, which is the acquisition channel for a marketplace). |
| **Money as integer cents** | Floats cannot represent 0.1 exactly; commission splits accumulate error; auditors do not accept "off by a cent". | Every boundary must convert deliberately. See `02-DATABASE.md` §6. |

---

## 7. Trade-offs consciously rejected

- **Redlock across multiple Redis nodes.** Extra complexity for a lock that is explicitly
  only a first-line filter. If the DB transaction is the real guarantee, a fancier
  distributed lock buys nothing.
- **Optimistic locking (version column) for the booking write.** Viable, and cheaper
  under low contention. Rejected because the contended case here is *popular slot, many
  simultaneous attempts* — precisely where optimistic locking degenerates into a retry
  storm. See `06-INTERVIEW-GUIDE.md` §5 for the full comparison; the point is that this
  was a choice with a reason, not a default.
- **`SERIALIZABLE` for every transaction.** Serialisation failures force retries and cost
  throughput. It is scoped to the booking path, where correctness beats throughput; reads
  run at `READ COMMITTED`.
- **Event sourcing the whole domain.** The ledger is append-only because money genuinely
  needs an audit trail. Making *everything* an event stream would be a large complexity
  bill for one narrow benefit.
- **GraphQL.** Attractive for a marketplace with varied client needs; rejected because
  REST + Swagger is faster to build, trivially cacheable at the CDN, and easier to
  rate-limit per endpoint. Query-cost analysis is a real burden GraphQL adds.
- **A service mesh.** Three services do not need mTLS sidecars, traffic shifting, and a
  control plane. That is complexity looking for a problem.

---

## 8. Where this architecture breaks

Stated plainly, because knowing the limits is the point.

| Pressure | First thing to break | Fix |
|---|---|---|
| Write throughput on one hot vendor | Row-lock contention on that vendor's slots | Contention is per-slot, not per-vendor, so this scales further than it looks. Beyond that: shard by vendor. |
| Total connections | Realtime memory before CPU | Horizontal scale; the hub is stateless apart from its own connections. |
| Read traffic on availability | Postgres read IOPS | Redis read-through cache with pub/sub invalidation, then read replicas. |
| Ledger table size | Query time on unindexed date ranges | Partition `ledger_entries` by month; archive cold partitions. |
| Postgres single-writer | Write ceiling | The genuine wall. Vertical scaling first, then shard by `vendor_id` — which is why `vendor_id` is on nearly every table from day one. |

Thresholds and the full scaling path are in `05-SAAS-MODEL.md` §7.
