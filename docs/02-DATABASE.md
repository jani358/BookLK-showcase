# 02 — Database

PostgreSQL 16 via Prisma. This document covers every table, the reasoning behind each
column, the index strategy, the slot state machine, money representation, and migrations.

> **Source of truth:** [`apps/api/prisma/schema.prisma`](https://github.com/jani358/BookLK/blob/main/apps/api/prisma/schema.prisma)
> and its migrations. The diagrams below use snake_case and show the designed model; a
> few designed columns are not in the current schema. For example, `Booking` has
> `slotId`, `activeSlotId`, `customerId`, `vendorId`, `serviceId`, `status`
> (`PENDING | CONFIRMED | CANCELLED | COMPLETED`), `priceCents`, `idempotencyKey`,
> `createdAt`, `cancelledAt` and `reminderSentAt`; there is no `reference`, no
> `NO_SHOW`, and the commission split is computed on the payment, not snapshotted on
> the booking. When this doc and the schema disagree, the schema wins.

---

## 1. ER diagram

```
┌───────────────────────┐
│        users          │
│───────────────────────│
│ id            uuid PK │
│ email         citext U│
│ password_hash text    │
│ role          enum    │◄──── CUSTOMER | VENDOR | ADMIN
│ name          text    │
│ phone         text    │
│ email_verified bool   │
│ created_at    tstz    │
│ updated_at    tstz    │
└───┬─────────────┬─────┘
    │1            │1
    │             │
    │             │N                        ┌──────────────────────────┐
    │        ┌────▼──────────────────┐      │     refresh_tokens       │
    │        │      vendors          │      │──────────────────────────│
    │        │───────────────────────│      │ id             uuid PK   │
    │        │ id            uuid PK │      │ user_id        uuid FK ──┼──┐
    │        │ owner_id  uuid FK U   │      │ token_hash     text   U  │  │
    │        │ slug          text  U │      │ family_id      uuid      │  │
    │        │ name          text    │      │ replaced_by_id uuid      │  │
    │        │ description   text    │      │ revoked_at     tstz      │  │
    │        │ city          text    │      │ expires_at     tstz      │  │
    │        │ address       text    │      │ user_agent     text      │  │
    │        │ status        enum    │      │ ip             inet      │  │
    │        │ commission_bps int    │      │ created_at     tstz      │  │
    │        │ payout_account text   │      └──────────────────────────┘  │
    │        │ timezone      text    │                                    │
    │        │ created_at    tstz    │◄───────────────────────────────────┘
    │        └───┬───────────────┬───┘
    │            │1              │1
    │            │N              │N
    │   ┌────────▼─────────┐   ┌─▼──────────────────────────┐
    │   │    services      │   │          slots             │
    │   │──────────────────│   │────────────────────────────│
    │   │ id       uuid PK │   │ id              uuid PK    │
    │   │ vendor_id  FK    │◄──┤ vendor_id       uuid FK    │
    │   │ name     text    │ 1 │ service_id      uuid FK    │
    │   │ description text │ N │ starts_at       tstz       │
    │   │ duration_min int │   │ ends_at         tstz       │
    │   │ price_cents  int │   │ status          enum       │◄─ FREE|HELD|BOOKED|
    │   │ currency  char(3)│   │ held_until      tstz       │   BLOCKED|CANCELLED
    │   │ is_active  bool  │   │ held_by_user_id uuid       │
    │   │ created_at tstz  │   │ version         int        │
    │   └──────────────────┘   │ created_at      tstz       │
    │                          │ updated_at      tstz       │
    │                          └──────┬─────────────────────┘
    │                                 │1
    │                                 │1  (active_slot_id is UNIQUE on bookings)
    │N                         ┌──────▼─────────────────────────┐
    └─────────────────────────►│           bookings             │
      customer_id              │────────────────────────────────│
                               │ id              uuid PK        │
                               │ reference       text U         │  BK-2026-0001A3
                               │ customer_id     uuid FK        │
                               │ vendor_id       uuid FK        │
                               │ service_id      uuid FK        │
                               │ slot_id         uuid FK        │  every booking ever
                               │ active_slot_id  uuid FK UNIQUE │◄── the safety net (NULL once cancelled)
                               │ status          enum           │
                               │ price_cents     int            │  snapshot
                               │ commission_cents int           │  snapshot
                               │ vendor_amount_cents int        │  snapshot
                               │ currency        char(3)        │
                               │ idempotency_key text UNIQUE    │
                               │ starts_at       tstz           │  denormalised
                               │ cancelled_at    tstz           │
                               │ cancel_reason   text           │
                               │ created_at      tstz           │
                               └───┬──────────────────┬─────────┘
                                   │1                 │1
                                   │N                 │0..1
                    ┌──────────────▼──────┐   ┌───────▼──────────────┐
                    │      payments       │   │       reviews        │
                    │─────────────────────│   │──────────────────────│
                    │ id          uuid PK │   │ id         uuid PK   │
                    │ booking_id  uuid FK │   │ booking_id uuid FK U │
                    │ provider    text    │   │ vendor_id  uuid FK   │
                    │ provider_ref text U │   │ customer_id uuid FK  │
                    │ idempotency_key U   │   │ rating      smallint │
                    │ amount_cents int    │   │ comment     text     │
                    │ currency   char(3)  │   │ vendor_reply text    │
                    │ status      enum    │   │ is_published bool    │
                    │ failure_code text   │   │ created_at  tstz     │
                    │ created_at  tstz    │   └──────────────────────┘
                    │ updated_at  tstz    │
                    └──────┬──────────────┘
                           │1
                           │N
                 ┌─────────▼──────────────────────┐        ┌────────────────────────┐
                 │        ledger_entries          │        │   webhook_events       │
                 │  (APPEND ONLY — never UPDATE)  │        │────────────────────────│
                 │────────────────────────────────│        │ id           uuid PK   │
                 │ id             bigserial PK    │        │ provider     text      │
                 │ payment_id     uuid FK         │        │ provider_event_id  U   │
                 │ booking_id     uuid FK         │        │ type         text      │
                 │ vendor_id      uuid FK         │        │ payload      jsonb     │
                 │ entry_type     enum            │◄─ CHARGE│ signature_ok bool     │
                 │ account        enum            │  PLATFORM_FEE  │ processed_at tstz│
                 │ amount_cents   bigint          │  VENDOR_PAYOUT │ created_at  tstz │
                 │ currency       char(3)         │  REFUND        └──────────────────┘
                 │ description    text            │
                 │ created_at     tstz            │        ┌────────────────────────┐
                 └────────────────────────────────┘        │     payout_jobs        │
                                                           │────────────────────────│
                                                           │ id         uuid PK     │
                                                           │ vendor_id  uuid FK     │
                                                           │ booking_id uuid FK     │
                                                           │ amount_cents int       │
                                                           │ status     enum        │
                                                           │ attempts   int         │
                                                           │ next_attempt_at tstz   │
                                                           │ last_error text        │
                                                           │ created_at tstz        │
                                                           └────────────────────────┘

  U = UNIQUE      tstz = timestamptz      bps = basis points (1000 = 10.00%)
```

---

## 2. Tables, column by column

### `users`

Every human. One table for all three roles rather than three tables, because auth,
password reset, and email verification are identical for all of them, and a user can
plausibly be both a customer and a vendor owner.

| Column | Type | Why |
|---|---|---|
| `id` | `uuid` PK | UUID not autoincrement: IDs appear in URLs and API responses. Sequential integers leak business volume (a competitor watching `/bookings/1042` learns your daily count) and make enumeration trivial. UUIDv7 is preferred over v4 — it is time-ordered, so index inserts stay local instead of scattering across the B-tree. |
| `email` | `citext` UNIQUE | `citext` gives case-insensitive uniqueness in the database itself. Lowercasing in application code works right up until one code path forgets, and then you have two accounts for one person. |
| `password_hash` | `text` | bcrypt output, 60 chars. Named `_hash` so nobody ever writes a plaintext password into it by accident. Never selected by default in queries. |
| `role` | `enum` | `CUSTOMER \| VENDOR \| ADMIN`. An enum, not a string: the database refuses a typo'd role. |
| `name`, `phone` | `text` | Phone is text, never a number — leading zeros and `+94` matter. |
| `email_verified` | `bool` | Gates payout setup and review posting. |
| `created_at`, `updated_at` | `timestamptz` | **Always `timestamptz`, never `timestamp`.** Sri Lanka is UTC+5:30; a naive timestamp is a bug waiting for the first customer in another timezone. Store UTC, render local. |

### `vendors`

The tenant root. Almost every business row carries `vendor_id`, which is what makes both
data isolation (`05-SAAS-MODEL.md` §3) and future sharding possible.

| Column | Type | Why |
|---|---|---|
| `owner_id` | `uuid` FK UNIQUE | One vendor per owning user for now. UNIQUE is a deliberate constraint that documents the current business rule; relaxing it later is a migration plus a `vendor_members` join table. |
| `slug` | `text` UNIQUE | URL identity: `/vendors/glow-salon-colombo`. SEO needs a readable URL; the UUID stays the API identity. |
| `status` | `enum` | `PENDING \| ACTIVE \| SUSPENDED`. New vendors are not bookable until reviewed. Suspension must not delete history, so this is a status, not a delete. |
| `commission_bps` | `int` | Platform cut in **basis points** (1000 = 10.00%). Integer basis points instead of a `float` percentage for the same reason money is integer cents — see §6. Per-vendor so negotiated rates are possible. |
| `payout_account` | `text` | Opaque provider reference, never raw bank details. Storing bank numbers pulls you into a compliance regime this project has no business entering. |
| `timezone` | `text` | IANA name (`Asia/Colombo`). Slot generation is timezone-aware or it breaks on DST for any vendor outside Sri Lanka. |

### `services`

What a vendor sells.

| Column | Type | Why |
|---|---|---|
| `duration_minutes` | `int` | Drives slot generation. Integer minutes because no salon books 90-second appointments. |
| `price_cents` | `int` | Current list price. **The booking snapshots this** — see `bookings.price_cents`. |
| `currency` | `char(3)` | ISO 4217 (`LKR`). Present from day one; retrofitting currency onto a money system is painful. |
| `is_active` | `bool` | Soft retire. Deleting a service would orphan historical bookings that must remain readable. |

### `slots`

The contended resource. This is where concurrency lives.

| Column | Type | Why |
|---|---|---|
| `starts_at`, `ends_at` | `timestamptz` | Both stored rather than start+duration: range queries (`WHERE starts_at >= ... AND ends_at <= ...`) are index-friendly, and a service's duration can change without rewriting history. |
| `status` | `enum` | `FREE \| HELD \| BOOKED \| BLOCKED \| CANCELLED`. State machine in §4. |
| `held_until` | `timestamptz` | When a `HELD` slot expires back to `FREE`. Nullable — only meaningful in `HELD`. |
| `held_by_user_id` | `uuid` | Who holds it. Without this, a user cannot resume their own checkout, and any user could complete a hold another user placed. |
| `version` | `int` | Optimistic-concurrency counter, bumped on every state change. Not the primary defence (that is `FOR UPDATE`), but it lets realtime clients discard out-of-order WebSocket messages: if the client already saw v7, it ignores an arriving v6. |

### `bookings`

| Column | Type | Why |
|---|---|---|
| `reference` | `text` UNIQUE | Human-facing (`BK-2026-0001A3`). Support conversations need something a customer can read over the phone; nobody reads a UUID aloud. |
| `slot_id` | `uuid` FK | Every booking ever made for the slot, cancelled ones included. |
| `active_slot_id` | `uuid` FK **UNIQUE**, nullable | **The single most important constraint in the schema** (since Phase 2, [ADR 0002](https://github.com/jani358/BookLK/blob/main/docs/adr/0002-active-slot-uniqueness.md)). Equals `slot_id` while the booking holds the slot and is set to NULL on cancellation; UNIQUE allows many NULLs, so one slot backs at most one *active* booking and a freed slot can be rebooked. Two CHECKs tie it to `slot_id` and to `status <> CANCELLED`. Before Phase 2 the UNIQUE sat on `slot_id` itself, which blocked rebooking a cancelled slot. Application logic and Redis locks can both be wrong; a unique index cannot. If everything else fails, the second insert raises `23505` and the customer sees "slot just taken" rather than arriving to a double-booked chair. |
| `price_cents`, `commission_cents`, `vendor_amount_cents` | `int` | **Snapshots, not joins.** If a vendor raises their price or renegotiates commission tomorrow, last month's booking and its ledger must still reconcile. Deriving money at read time from mutable rows is how ledgers silently stop balancing. Deliberate denormalisation. |
| `idempotency_key` | `text` UNIQUE, nullable | The client-supplied key that makes the create call retry-safe. The idempotency check is a lookup on this unique column in Postgres (no Redis entry): a replay with the same key returns the existing booking, and two racing first attempts cannot both insert. |
| `starts_at` | `timestamptz` | Denormalised from the slot so "my upcoming bookings" is one indexed query with no join. |
| `status` | `enum` | `PENDING \| CONFIRMED \| CANCELLED \| COMPLETED`. |
| `cancelled_at`, `cancel_reason` | | Refund policy is time-based, so *when* the cancellation happened is a money-relevant fact. |

### `payments`

| Column | Type | Why |
|---|---|---|
| `provider`, `provider_ref` | `text`, UNIQUE | Which provider and its ID. UNIQUE on `provider_ref` prevents recording the same provider charge twice from a replayed webhook. |
| `idempotency_key` | `text` UNIQUE | Sent to the provider so a network retry cannot create a second charge. |
| `status` | `enum` | `PENDING \| SUCCEEDED \| FAILED \| REFUNDED \| PARTIALLY_REFUNDED`. |
| `failure_code` | `text` | Provider decline reason. Support cannot help without it. |

### `ledger_entries` — append only

Every money movement, one row each, never updated, never deleted.

| Column | Type | Why |
|---|---|---|
| `id` | `bigserial` | Monotonic ordering matters here and these IDs are internal, so the enumeration argument for UUIDs does not apply. |
| `entry_type` | `enum` | `CHARGE \| PLATFORM_FEE \| VENDOR_PAYOUT \| REFUND \| REVERSAL \| ADJUSTMENT`. |
| `account` | `enum` | `CUSTOMER \| PLATFORM \| VENDOR`. Which bucket moved. |
| `amount_cents` | `bigint` | Signed. Credits positive, debits negative — the entries for one booking must sum to zero. `bigint` because a lifetime sum overflows `int` faster than people expect (LKR cents: `int` caps around LKR 21.4M). |
| `description` | `text` | Human-readable for auditors. |

Reasoning in §7.

### `refresh_tokens`

| Column | Type | Why |
|---|---|---|
| `token_hash` | `text` UNIQUE | **Hash, never the token.** A stolen database dump must not yield usable sessions. Same reasoning as passwords. |
| `family_id` | `uuid` | All tokens descended from one login share a family. Reuse detection revokes the whole family — see `03-SECURITY.md` §3. |
| `replaced_by_id` | `uuid` | Rotation chain. Presence of this value on a token being presented is exactly the reuse signal. |
| `revoked_at` | `timestamptz` | Nullable; set on logout, rotation, or family revocation. |
| `user_agent`, `ip` | `text`, `inet` | "Your active sessions" UI, and forensic value after a compromise. |

### `webhook_events`

| Column | Why |
|---|---|
| `provider_event_id` UNIQUE | Providers retry aggressively and deliver duplicates by design. This UNIQUE is the dedupe. |
| `payload` `jsonb` | Raw event stored verbatim. When a payment dispute arrives six months later, the original body is the evidence. |
| `signature_ok` `bool` | Whether the HMAC verified. Failures are recorded rather than silently dropped — a spike in failed signatures is either a rotated secret or an attack, and both need alerting. |

### `payout_jobs`

A durable queue row per vendor payout, with `attempts`, `next_attempt_at` (exponential
backoff), and `last_error`. Payouts move real money to third parties and must survive a
process restart, so the queue is a table, not an in-memory job list.

### `OutboxEvent` — transactional outbox (Phase 1)

One row per domain event, INSERTed in the same transaction as the booking or payment
change it describes (see [ADR 0001](https://github.com/jani358/BookLK/blob/main/docs/adr/0001-outbox-over-dual-writes.md)). `id` (uuid) is
the event's `eventId`. `seq` (bigserial) gives the insert order, because `createdAt`
cannot: Postgres `now()` is the transaction start time, so every row of one transaction
ties. `payload` is the full JSON envelope, `topic` the destination, `publishedAt` is NULL
until the relay has published it, and `attempts` / `lastError` / `nextAttemptAt` drive
backoff. Indexes: `(publishedAt, nextAttemptAt, seq)` for the relay's claim query and
`(aggregateType, aggregateId, seq)` for its head-of-line check.

### `ProcessedEvent` — consumer dedupe

Primary key `(eventId, consumer)`. A consumer inserts its row with `ON CONFLICT DO
NOTHING` in the same transaction as its own writes, so a redelivered event changes
nothing. Keyed per consumer: one event is processed once by *each* consumer.

### `Notification`

Written by the notification-sender consumer. `commandId` is UNIQUE (the
`notification.send` command's eventId), a second guard against sending twice.

### Phase 2: payments that reconcile

| Table | What it holds | Key constraints |
|---|---|---|
| `Refund` | One refund of all or part of a payment: amount, frozen fee/vendor split, reason, status (PENDING, SUCCEEDED, FAILED), provider refund id, attempts | UNIQUE `idempotencyKey`, UNIQUE `providerRefundRef`, CHECK split sums and amount > 0 |
| `LedgerEntry` (new columns) | `paymentId`, `refundId` on reversal entries | UNIQUE `(refundId, type)`; a trigger rejects every UPDATE |
| `Payment` (new columns) | `currency`, `refundedCents`, `providerChargeId`; status adds PARTIALLY_REFUNDED | CHECK split sums, `0 <= refundedCents <= amountCents` |
| `Payout` (new columns) | `paymentId`, `refundId` (negative clawback rows), `batchId` | UNIQUE `refundId` |
| `PayoutBatch` | One netted transfer per vendor per run; its id is the transfer idempotency key | CHECK amount > 0, UNIQUE `transferRef` |
| `InboundWebhook` | Every verified provider webhook, written by apps/webhooks with its outbox row | UNIQUE `(provider, providerEventId)` |
| `Receipt` | The generated PDF's number (BLK-YYYY-NNNNNN), storage key, SHA-256 | UNIQUE `paymentId`, `sequence`, `receiptNumber` |
| `Booking.reminderSentAt` | Stamped once by the reminders job | the conditional update on NULL is the gate |
| `ReconciliationRun` / `ReconciliationIssue` | Nightly comparison runs and the gaps they found | UNIQUE `(kind, provider, providerRef)` so a recurring gap is one issue |

Reasoning: [ADR 0003](https://github.com/jani358/BookLK/blob/main/docs/adr/0003-payment-providers-and-webhooks-service.md),
[ADR 0004](https://github.com/jani358/BookLK/blob/main/docs/adr/0004-refunds-as-ledger-reversals.md),
[ADR 0005](https://github.com/jani358/BookLK/blob/main/docs/adr/0005-bullmq-jobs-and-nightly-reconciliation.md).

> Migrations: `prisma/migrations/20260901000000_init` is the baseline of the pre-Phase-1
> schema, and `20261030000000_event_backbone` adds the three tables above. A database
> created earlier with `prisma db push` is baselined with
> `pnpm exec prisma migrate resolve --applied 20260901000000_init`.

---

## 3. Index strategy

Every index is a write-time cost and disk. These exist because a specific query needs them.

| Index | Table | Serves | Notes |
|---|---|---|---|
| `UNIQUE (email)` | users | Login lookup | Also enforces the business rule |
| `UNIQUE (slug)` | vendors | `/vendors/:slug` page load | |
| `(city, status)` | vendors | "salons in Colombo" browse | Composite ordered by selectivity for the actual filter |
| `(vendor_id, is_active)` | services | Vendor page service list | |
| **`(vendor_id, starts_at, status)`** | slots | **The hottest query in the app** | See below |
| `(status, held_until)` | slots | Expiry sweeper finding stale `HELD` rows | Partial: `WHERE status = 'HELD'` |
| `UNIQUE (active_slot_id)` | bookings | The double-booking guarantee (NULL once cancelled, so many cancelled rows are allowed) | Correctness first, speed second; plus a plain index on `slot_id` for history |
| `(customer_id, starts_at DESC)` | bookings | "My bookings", newest first | `DESC` matches ORDER BY, so no sort node |
| `(vendor_id, starts_at)` | bookings | Vendor's day view | |
| `UNIQUE (reference)` | bookings | Support lookup | |
| `(booking_id)` | payments | Payment for a booking | |
| `UNIQUE (provider_ref)` | payments | Webhook dedupe | |
| `(booking_id)`, `(vendor_id, created_at)` | ledger_entries | Reconciliation, vendor statements | |
| `UNIQUE (token_hash)` | refresh_tokens | Refresh verification | |
| `(user_id, revoked_at)` | refresh_tokens | Revoke-all-sessions | |
| `(status, next_attempt_at)` | payout_jobs | Queue poll | Partial: `WHERE status = 'PENDING'` |

### The one that matters: `slots (vendor_id, starts_at, status)`

Availability lookup is the query that runs on every vendor page view:

```sql
SELECT id, starts_at, ends_at, status
FROM slots
WHERE vendor_id = $1
  AND starts_at >= $2
  AND starts_at <  $3
  AND status = 'FREE'
ORDER BY starts_at;
```

Column order is not arbitrary:

1. **`vendor_id` first** — an equality predicate, and the most selective (one vendor out
   of thousands). A B-tree can only range-scan on the *last* used column, so every
   equality predicate must come before any range predicate.
2. **`starts_at` second** — the range. Positioned here, the index scan reads exactly the
   matching date window and stops. It also supplies rows already ordered, so `ORDER BY
   starts_at` needs no sort.
3. **`status` third** — filtered from the index rather than the heap.

Put `starts_at` first instead and every vendor's slots for that week interleave in the
scan; Postgres reads and discards most of them. On 50k slot rows this is roughly a 40x
difference in rows examined.

**Verify, do not assume:**

```sql
EXPLAIN (ANALYZE, BUFFERS)
SELECT ... ;
```

What you want to see:

```
Index Scan using slots_vendor_starts_status_idx on slots
  Index Cond: ((vendor_id = '...') AND (starts_at >= '...') AND (starts_at < '...'))
  Filter: (status = 'FREE')
  Rows Removed by Filter: 0
  Buffers: shared hit=7
```

Red flags: `Seq Scan` on a large table (index unused or not selective), `Rows Removed by
Filter` in the thousands (the predicate is not being served by the index), a `Sort` node
(index order does not match `ORDER BY`), or `Buffers: shared read=` far exceeding `hit=`
(cold cache — run it twice before drawing conclusions).

Always `EXPLAIN ANALYZE` against **seeded, realistically-sized data**. On 20 rows Postgres
picks a sequential scan because it is genuinely faster, and you learn nothing.

---

## 4. The slot state machine

```
                   vendor generates availability
                              │
                              ▼
      ┌──────────────────► ┌──────┐ ◄─────────────────────┐
      │                    │ FREE │                       │
      │                    └───┬──┘                       │
      │                        │  customer starts checkout│
      │                        │  hold(TTL 10 min)        │
      │  held_until passed     ▼                          │  booking cancelled
      │  (sweeper or           ┌──────┐                   │  (per refund policy)
      │   lazy check)          │ HELD │                   │
      └────────────────────────┤      │                   │
                               └───┬──┘                   │
                    payment confirmed│                    │
                                    ▼                     │
                               ┌────────┐                 │
                               │ BOOKED ├─────────────────┘
                               └────┬───┘
                                    │ time passes, service delivered
                                    ▼
                              (booking → COMPLETED;
                               slot stays BOOKED as history)

      ┌─────────┐   vendor blocks time off      ┌───────────┐
      │  FREE   ├──────────────────────────────►│  BLOCKED  │
      └─────────┘◄──────────────────────────────┴───────────┘
                        vendor unblocks

      CANCELLED — vendor deletes a slot that was never booked.
                  A booked slot is never deleted; history is immutable.
```

**Legal transitions only** (anything else raises):

| From | To | Trigger | Guard |
|---|---|---|---|
| `FREE` | `HELD` | Customer begins checkout | Row lock; must still be `FREE` |
| `FREE` | `BOOKED` | Direct book (no payment step) | Row lock; must still be `FREE` |
| `FREE` | `BLOCKED` | Vendor blocks time | Caller must own the vendor |
| `HELD` | `BOOKED` | Payment succeeded | `held_by_user_id` must match caller and `held_until > now()` |
| `HELD` | `FREE` | Hold expired or abandoned | `held_until <= now()`, or the holder cancels |
| `BOOKED` | `FREE` | Booking cancelled | Refund policy applied first |
| `BLOCKED` | `FREE` | Vendor unblocks | |

**Why `HELD` exists at all.** Without it, the slot stays `FREE` during the 30–90 seconds
a customer spends on the payment form. Two customers reach payment for the same slot, one
pays, the other pays — and now you owe a refund and an apology. `HELD` moves the race to
the *start* of checkout, where losing costs a user nothing but a re-pick.

**Why the hold has a TTL.** Abandoned carts are the norm. A hold with no expiry lets one
user who closed their laptop remove a slot from sale permanently. Ten minutes is long
enough to complete payment and short enough that abandonment costs little inventory.

**How expiry actually happens — belt and braces:**

1. **Lazy**: any read of a `HELD` slot whose `held_until` has passed treats it as `FREE`
   and updates it in place. Correct even if all background jobs are dead.
2. **Sweeper**: a periodic job flips expired holds and publishes the change so watching
   clients see the slot reappear. This is a UX improvement, not a correctness mechanism.

Relying only on the sweeper means a job outage silently makes slots unbookable. Relying
only on lazy expiry means a slot appears taken until someone happens to look at it. Both
together give correctness *and* good UX, and it costs perhaps twenty lines.

---

## 5. Money is integer cents, never floats

```
Wrong:   price DECIMAL/FLOAT = 5000.00
Right:   price_cents INTEGER = 500000        -- LKR 5,000.00
```

**The mechanical reason.** IEEE-754 binary floating point cannot represent 0.1, 0.2, or
0.01 exactly, for the same reason decimal cannot represent 1/3 exactly:

```js
0.1 + 0.2                      // 0.30000000000000004
5000.00 * 0.10                 // 500.0000000000001
(0.1 + 0.2 === 0.3)            // false
```

One rounding artefact looks harmless. Across a commission split repeated a hundred
thousand times, the ledger stops summing to zero, and reconciliation becomes a manual
hunt for cents.

**Integers make it exact.** `500000` is exactly LKR 5,000.00. Addition and subtraction are
exact. Multiplication needs one explicit, deliberate rounding decision — and that is the
point: rounding becomes a visible line of code with a comment, not an invisible property
of the number type.

```ts
// Commission in basis points: 1000 bps = 10.00%
const commissionCents = Math.round((priceCents * commissionBps) / 10_000);
const vendorAmountCents = priceCents - commissionCents;
// Subtracting rather than computing separately GUARANTEES the parts sum to the whole.
// Rounding both independently can produce a total off by one cent.
```

That last line is the one to say out loud in an interview. Compute one side, derive the
other by subtraction, and the invariant `commission + vendor = total` holds by
construction rather than by luck.

**Why not `NUMERIC`/`DECIMAL`?** It is genuinely correct and a defensible choice — a
Postgres-only system could use `NUMERIC(12,2)` safely. Integer cents wins here because
the values cross into JavaScript, where `NUMERIC` arrives as either a lossy float or a
string needing a decimal library, and into Go and JSON. An integer survives every hop
unchanged. `Number.MAX_SAFE_INTEGER` is ~9×10¹⁵, so LKR ~90 trillion — not a constraint.

**Rules enforced across the codebase:**

1. Every money column is named `*_cents` — the unit is in the name, so no one has to
   guess.
2. Money never becomes a float, ever, at any layer.
3. Conversion to display happens exactly once, at the UI edge:
   `new Intl.NumberFormat('en-LK', {style:'currency', currency:'LKR'}).format(cents/100)`.
4. Percentages are basis-point integers, never floats.
5. Every money row carries its `currency`. Comparing or summing across currencies must be
   impossible by accident.

---

## 6. Why the ledger is append-only

`ledger_entries` is `INSERT` only. No `UPDATE`, no `DELETE` — enforced by convention in
the service layer and by a `REVOKE UPDATE, DELETE` grant on the production role.

**Why:**

1. **Audit.** "What did this vendor earn in March?" must return the same answer today and
   in two years. Mutable rows cannot promise that.
2. **Corrections are events too.** A mistaken charge is fixed by inserting a compensating
   `REVERSAL`, not by editing history. The record then shows both what happened and what
   was done about it — which is exactly what an auditor or a disputing customer needs.
3. **Debuggability.** With immutable entries, "how did this balance get here?" is answered
   by replaying rows in order. With mutable rows, the answer is gone.
4. **Concurrency.** Append-only means no row contention on a running-balance column.
   Balance is `SUM(amount_cents)`, or a materialised view refreshed on a schedule.

**Double-entry thinking.** Entries for one booking sum to zero:

```
booking BK-2026-0001A3, LKR 5,000.00, 10% commission

 id  entry_type      account    amount_cents   description
─────────────────────────────────────────────────────────────────────
  1  CHARGE          CUSTOMER      -500000     Customer paid for BK-...
  2  CHARGE          PLATFORM      +500000     Funds received
  3  PLATFORM_FEE    PLATFORM       -50000     10% commission recognised
  4  PLATFORM_FEE    PLATFORM       +50000     Fee to platform revenue
  5  VENDOR_PAYOUT   PLATFORM      -450000     Owed to vendor
  6  VENDOR_PAYOUT   VENDOR        +450000     Vendor receivable
─────────────────────────────────────────────────────────────────────
                                  SUM = 0     ← the invariant
```

A nightly reconciliation job asserts `SUM(amount_cents) = 0` per booking and alerts on any
non-zero result. That single check catches almost every money bug before a customer does.
Full worked example including refunds in `05-SAAS-MODEL.md` §4.

---

## 7. Migration strategy

Prisma Migrate, checked into git. CI applies them to a fresh database with
`pnpm prisma:deploy` before the integration tests; in the k3d lab the chart runs them
before the API starts.

```bash
# Development — creates a timestamped SQL file, applies it, regenerates the client
pnpm prisma migrate dev --name add_slot_held_until

# CI / production — applies pending migrations only, never generates or resets
pnpm prisma migrate deploy

# After a schema change without a migration (e.g. after pulling)
pnpm prisma generate
```

**Rules:**

1. **Migrations are code.** Reviewed in PRs, never edited after being applied anywhere
   shared. Editing an applied migration breaks the checksum and every other environment.
2. **Never `migrate reset` against anything but local.** It drops the database. It is in
   the local workflow only.
3. **Expand → migrate → contract for breaking changes.** Renaming
   `bookings.price` → `bookings.price_cents` is three deploys, not one:
   - *Expand*: add `price_cents`, backfill it, write to both columns. Old and new code both work.
   - *Migrate*: switch all reads to `price_cents`. Deploy. Verify.
   - *Contract*: drop `price`. Deploy.
   One-shot rename means the moment the migration lands, still-running old pods query a
   column that no longer exists — a self-inflicted outage during every rolling deploy.
4. **Always add a column nullable or with a default.** `ADD COLUMN NOT NULL` without a
   default fails on a non-empty table. Add nullable, backfill in batches, then add the
   constraint.
5. **Create indexes concurrently in production.** Plain `CREATE INDEX` takes an
   `ACCESS EXCLUSIVE`-adjacent lock that blocks writes for the duration. Use
   `CREATE INDEX CONCURRENTLY` in a raw migration; it is slower but does not block. It
   cannot run inside a transaction, so it needs its own migration file.
6. **Backfills are batched.** `UPDATE bookings SET x = y` on a million rows holds locks
   and bloats WAL. Loop in batches of ~1,000 with a short pause.
7. **Every migration is tested against a restored production-shaped dump before it ships.**
   Migrations that ran in 40ms on a seeded dev database can take 40 minutes on real data.

**Seeding** (`prisma/seed.ts`, run via `pnpm prisma:seed`) creates: an admin, three
vendors with services, ~30 days of generated slots each, a few customers, and a handful of
completed bookings with their ledger entries. Enough data for `EXPLAIN` to make realistic
plan choices, and enough for the frontend to look alive.

---

## 8. Common queries and their plans

### Availability for a vendor over a week

```sql
SELECT id, starts_at, ends_at, status
FROM slots
WHERE vendor_id = $1 AND starts_at >= $2 AND starts_at < $3 AND status = 'FREE'
ORDER BY starts_at;
```
Index scan on `(vendor_id, starts_at, status)`. No sort node — index order matches
`ORDER BY`. Expect single-digit milliseconds and a handful of buffer hits. This is the
query to have memorised.

### Locking a slot to book it

```sql
BEGIN ISOLATION LEVEL READ COMMITTED;   -- the explicit locks below are the guarantee

SELECT id, status, version
FROM slots
WHERE id = $1
FOR UPDATE;                      -- blocks other writers on THIS row only

-- application asserts status = 'FREE'

UPDATE slots SET status = 'BOOKED', version = version + 1, updated_at = now()
WHERE id = $1;

INSERT INTO bookings (..., active_slot_id) VALUES (..., $1);   -- UNIQUE(active_slot_id) is the backstop

COMMIT;
```

`FOR UPDATE` takes a row-level exclusive lock. Concurrent transactions requesting the same
row *block* until commit, then re-read and find `BOOKED`. Because the lock is per-row,
bookings for different slots never contend. `NOWAIT` is a reasonable variant — fail
immediately rather than queue — since the Redis lock has already filtered most losers.

Full treatment in `06-INTERVIEW-GUIDE.md` §5.

### Vendor earnings for a month

```sql
SELECT COALESCE(SUM(amount_cents), 0) AS earned_cents
FROM ledger_entries
WHERE vendor_id = $1
  AND entry_type = 'VENDOR_PAYOUT'
  AND account = 'VENDOR'
  AND created_at >= $2 AND created_at < $3;
```
Index scan on `(vendor_id, created_at)` then filter. Fine to millions of rows. Past that,
partition by month so the planner prunes irrelevant partitions entirely, or maintain a
`vendor_monthly_earnings` rollup — but only when `EXPLAIN ANALYZE` says the simple query
has actually become slow. Optimising before measuring is how you end up maintaining a
rollup table that was never needed.

### Upcoming bookings for a customer

```sql
SELECT b.id, b.reference, b.starts_at, b.status, v.name AS vendor_name, s.name AS service_name
FROM bookings b
JOIN vendors  v ON v.id = b.vendor_id
JOIN services s ON s.id = b.service_id
WHERE b.customer_id = $1 AND b.starts_at >= now() AND b.status IN ('CONFIRMED','PENDING_PAYMENT')
ORDER BY b.starts_at
LIMIT 20;
```
Index scan on `(customer_id, starts_at DESC)` — usable in either direction — then two
nested-loop lookups on primary keys. `starts_at` being denormalised onto `bookings` is
what keeps the filter and the sort on one table instead of forcing a join to `slots`
before filtering.

### Finding expired holds

```sql
SELECT id, vendor_id FROM slots
WHERE status = 'HELD' AND held_until <= now()
LIMIT 500;
```
Partial index `(status, held_until) WHERE status = 'HELD'` — the index only contains held
rows, so it stays tiny (a few dozen entries) no matter how large `slots` grows. `LIMIT`
bounds each sweeper pass so a backlog cannot produce one enormous transaction.
