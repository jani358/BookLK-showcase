# Load test report: the booking spike (UPGRADE-PLAN 5.3)

**Date:** 2026-10-31 · **Script:** [`load/booking-spike.js`](../load/booking-spike.js) · **How to run:** [`load/README.md`](../load/README.md)

**Question:** when a crowd hits "book" on the same few slots at the same instant, does
BookLK ever sell one slot twice, and how fast does it answer?

**Short answer:** zero double bookings in every run, checked straight from Postgres.
The spike found two real problems: Serializable isolation made bookings for different
slots abort each other (slots left unsold), and the API pod is CPU-bound. Both were
measured and the first one is fixed. The p95 < 300 ms target is **not met** on this
laptop: p95 is 3.2 s at 200 VUs and 6.0 s at 500 VUs.

## Setup (and why it is scaled down)

| | |
|---|---|
| Machine | One Windows 11 laptop. Docker Desktop is limited to **6 CPUs / 10 GB RAM** and shared with another project's containers. |
| Cluster | k3d, one K3s server, no agents. The whole BookLK chart in-cluster: api, relay, worker, webhooks, realtime, web, Postgres, Redis, Redpanda, Mongo, Prometheus, Grafana. |
| Path | k6 on the host -> Traefik Ingress (`127.0.0.1:8180`, `Host: booklk.localhost`) -> API pod(s) -> Postgres + Redis. The same path a browser takes. |
| Limits | API pod: 1 CPU / 512 Mi. Postgres: 1 CPU / 512 Mi. |
| Load generator | k6 runs on the same laptop, so it competes with the cluster for CPU. |
| Scenario | `per-vu-iterations`: every VU starts at once, tries up to 3 slots (random start, walking forward), and stops at the first 201. 409 is an expected answer. |
| Main size | **200 VUs racing for 20 slots** (10 customers per slot). The plan's 500 VUs / 50 slots was run once at the end. |
| Correctness check | `pnpm load:verify` after each run reads Postgres directly: no slot with more than one active booking, BOOKED slots have exactly one, FREE slots none. |

The scale is set by the laptop, not by BookLK. Every number below is relative to this
machine and is useful for comparing before and after, not as a capacity figure.

## Results

All runs: **0 double bookings** (`load:verify` PASS), **0 5xx**, **0 unexpected errors**.

| # | Build | VUs / slots | Booked | Requests (req/s) | Median | p95 | p99 | Write conflicts (P2034) |
|---|---|---|---|---|---|---|---|---|
| 1 | baseline: 1 API pod, Serializable | 200 / 20 | 20/20 | 573 (85) | 535 ms | 5.63 s | 6.33 s | not counted |
| 2 | + unlocked pre-check, 1 pod (warm) | 200 / 20 | 20/20 | 578 (92) | 374 ms | 5.52 s | 5.91 s | not counted |
| 3 | + 2 API pods, still Serializable | 200 / 20 | **19/20** | 582 (126) | 530 ms | 3.44 s | 3.71 s | 264 + 65 in the logs |
| 4 | same as 3, again | 200 / 20 | **18/20** | 583 (140) | 468 ms | 3.28 s | 3.74 s | (same window) |
| 5 | + **READ COMMITTED**, 2 pods | 200 / 20 | 20/20 | 561 (125) | **247 ms** | 3.25 s | 3.82 s | **0** |
| 6 | same as 5, again | 200 / 20 | 20/20 | 562 (141) | 248 ms | 3.16 s | 3.69 s | **0** |
| 7 | same as 5, plan size | 500 / 50 | 50/50 | 1,411 (187) | 174 ms | 5.97 s | 6.65 s | **0** |

Latency is k6's `http_req_duration` for `POST /api/bookings`, 201 and 409 together.

## Finding 1: the API is CPU-bound, not Postgres

First guess: losers queue on the Prisma connection pool, because every request that
gets the Redis lock opens a full transaction just to find the slot already BOOKED
(p99 sat just above the 5 s `maxWait`). Change: a plain, unlocked status read that
rejects a slot already BOOKED before the lock and the transaction
(`bookings.service.ts`, with unit tests).

**Result (run 2): almost no change** (p95 5.63 s -> 5.52 s, no pool errors in the logs).
The guess was wrong, so the next step was to measure. The cgroup counters
(`/sys/fs/cgroup/cpu.stat`) were read before and after one run at 1 pod:

| Container | CPU used during a ~6 s run | Throttled |
|---|---|---|
| API (limit 1 CPU) | **5.65 s**, so about 1 full core the whole time | 0.85 s (44 periods) |
| Postgres (limit 1 CPU) | 0.86 s | 0 |

The API was pinned at its CPU limit while Postgres was mostly idle. The bottleneck is
API CPU (about 10 ms of CPU per request through Nest, JWT, the rate-limit script and
Prisma), not row locks. This contradicts the earlier assumption in the cloud lab notes
("the API's bottleneck is Postgres row locks, which more API pods would not fix").

**Fix: scale the API out.** `api.replicas: 2` in `values-k3d.yaml`, shipped as a Git
commit and synced by ArgoCD. Throughput rose from 85-92 to 126-140 req/s, and p95 fell
from about 5.5 s to about 3.3 s (runs 3-4). The pre-check stays: it is correct and
removes a doomed transaction for every late loser.

## Finding 2: Serializable made bookings for different slots abort each other

With two pods, runs 3 and 4 left **1-2 slots unbooked**, even though 10 customers were
trying for each. The API logs had hundreds of
`Transaction failed due to a write conflict or a deadlock` (Postgres 40001, Prisma
P2034), which the API returns as 409 "Write conflict, please retry".

Under SERIALIZABLE, Postgres also tracks predicate (read) locks. Bookings for
*different* slots touch the same `Booking` indexes and outbox table, so Postgres aborted
some of them to keep a serial order. When the one request holding a slot's Redis lock
was aborted, every other request for that slot had already been turned away, and the
slot stayed FREE. That is lost sales and wasted CPU.

Serializable bought nothing here: every row the transaction decides on is already
locked, the slot by `SELECT ... FOR UPDATE` and the booking by `UNIQUE(activeSlotId)`.
**Fix:** the booking transaction now runs at READ COMMITTED (test first; the concurrency
suite with its 20-way and 19-way races and the raw-INSERT backstop stays green).
Recorded in [ADR 0002](adr/0002-active-slot-uniqueness.md).

**Result (runs 5-6):** 20/20 slots booked, **0 write conflicts**, and the median halved
(468-530 ms -> 247 ms). p95 is unchanged (about 3.2 s), because it comes from CPU
queueing (finding 1), not from the aborts.

## What is not solved

- **p95 < 300 ms is not met.** 200 requests landing in the same instant on 2 API pods
  with 1 CPU each queue for CPU. Each pod handles about 65-70 req/s, so the last request
  of a 200-request burst waits about 1.5 s or more, and longer when k6 itself takes
  laptop CPU. At 500 VUs (run 7) the burst is 2.5 times bigger and p95 is 6 s.
- **Next steps, in order:**
  1. Profile one request (`node --cpu-prof` on a pod) to find where the ~10 ms of CPU
     goes. The rate-limit Lua call, JWT verification and Prisma's interactive
     transaction are the suspects.
  2. Move the burst out of the request: an HPA on the API's CPU (this run argues for
     one), or a waiting room / queue in front of booking for "slots just opened" events.
  3. Re-run on a machine where k6 and the cluster do not share CPUs.

## How to explain this in an interview

- "Correctness held at every size: zero double bookings, checked in the database, not
  inferred from HTTP codes."
- "My first optimisation didn't move the number, so I stopped guessing and read the
  cgroup CPU counters: the API was pinned at its limit and Postgres was idle. Then I
  scaled the API, not the database."
- "Scaling out exposed a second bug. Serializable aborted bookings for unrelated slots,
  which left slots unsold. The row lock and the unique constraint were already the real
  guarantee, so READ COMMITTED was correct, and the conflicts dropped to zero."
- "I didn't hit the p95 target on a laptop, and I can say why: CPU queueing during a
  burst. The fix is capacity or admission control, not more locking."
