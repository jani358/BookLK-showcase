# ADR 0002: One active booking per slot, enforced by `Booking.activeSlotId`

- **Status:** Accepted
- **Date:** 2026-10-30
- **Scope:** `apps/api` (bookings, slots), migration `20261031000000_active_slot_booking`
- **Related:** UPGRADE-PLAN 2.4, [ADR 0001](0001-outbox-over-dual-writes.md)

## Context

When this ADR was written, the double-booking guard had four layers: idempotency key,
Redis lock, `SELECT … FOR UPDATE` in a Serializable transaction, and `UNIQUE(slotId)` on
`Booking` as the backstop. (The transaction now runs at READ COMMITTED; see the update
at the end.)

Phase 1 found a bug in the last layer. `cancel()` frees the slot, but the CANCELLED
booking row keeps its `slotId`, and `UNIQUE(slotId)` covers every row, so a second
customer booking the freed slot gets P2002. The concurrency suite's "frees the slot
on cancellation so it can be rebooked" test was `it.skip` until this ADR.

What we need: at most one **active** booking (PENDING, CONFIRMED or COMPLETED) per slot,
any number of CANCELLED rows kept as history, and the guarantee still enforced by
Postgres, not by application code.

## Options considered

### A. Partial unique index: `UNIQUE (slotId) WHERE status <> 'CANCELLED'`

The textbook answer, and exactly the right semantics. But Prisma 5 cannot express
partial indexes in `schema.prisma`. The index would live only in a hand-written
migration, `prisma migrate dev` would see it as drift and generate a migration that
drops it, and anyone regenerating the schema could silently remove the last
double-booking guard. Too fragile for the one constraint that must never disappear.

### B. Delete or move the cancelled row (e.g. to `CancelledBooking`)

Removes the conflict, but the ledger, payment, refund and review rows reference the
booking. Moving it breaks those foreign keys or duplicates the model. History should
stay where it is.

### C. Nullable `activeSlotId` with a normal unique index (chosen)

`activeSlotId` equals `slotId` while the booking holds the slot and becomes `NULL` on
cancellation. A normal `UNIQUE(activeSlotId)` allows any number of NULLs, so it has
the partial index's semantics, and Prisma models it natively (`String? @unique` plus
a relation `Slot.activeBooking`). No drift, no hand-maintained index.

## Decision

Use **C**:

- `Booking.slotId` stays (non-unique, indexed): every booking ever made for a slot.
- `Booking.activeSlotId String? @unique`: the claim on the slot. `create()` sets it,
  `cancel()` sets it to NULL in the same conditional update that flips the status.
- Two CHECK constraints in the migration make the column impossible to misuse:
  `activeSlotId IS NULL OR activeSlotId = slotId`, and
  `(status = 'CANCELLED') = (activeSlotId IS NULL)`.
  "Cancelled but still holding the slot" and "active but not holding it" cannot exist.
- The migration backfills `activeSlotId` for every non-cancelled booking before the
  unique index is created; the old `UNIQUE(slotId)` guarantees the backfill is unique.

## Consequences

- A cancelled slot can be rebooked. The un-skipped test proves it, plus two new ones:
  19 customers racing for a freed slot still produce exactly one winner, and a raw
  INSERT of a second active booking that bypasses all application code is rejected
  with P2002.
- The four-layer guard is unchanged in shape; layer 4 now guards the right thing.
- Reads that want "the booking for this slot" must use `activeBooking`, not `bookings`.
  The vendor calendar API keeps its old response shape (`booking`) by mapping it.
- Cost: one extra nullable column and two CHECK constraints. Prisma does not know
  about the CHECKs; they are documented in the schema comment and the migration.

## Update 2026-10-31: the booking transaction runs at READ COMMITTED

The k6 spike ([LOAD-TEST-REPORT](../LOAD-TEST-REPORT.md)) showed Serializable doing harm.
Bookings for *different* slots aborted each other with serialization failures
(SQLSTATE 40001, Prisma P2034, returned as 409 "Write conflict, please retry"): 264 in
one API pod's logs over two short runs. When the only request holding a slot's Redis
lock was aborted that way, the slot stayed FREE while every other request had already
been turned away, so 1-2 of 20 slots were never booked.

Serializable bought nothing here. Every row the transaction decides on is locked
explicitly: the slot by `SELECT ... FOR UPDATE`, and the booking by
`UNIQUE(activeSlotId)`. The transaction now uses READ COMMITTED, and the concurrency
suite (20-way and 19-way races, raw INSERT backstop) is unchanged and green. Other
money paths keep their own isolation choices. The trade-off: if this transaction
ever starts reading rows it does not lock, it has to lock them itself.
