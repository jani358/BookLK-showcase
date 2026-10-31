# BookLK

**Full source is private. I can walk through it or share access with interviewers on request.**

A multi-vendor booking marketplace for Sri Lanka. Salons, clinics, tutors and repair shops publish time
slots, customers book and pay, vendors get paid out, and the platform keeps a commission.

This repo used to stand in for a private codebase. The main repo is public now, so this is a short tour
with a few excerpts. Everything else, including all the tests, is in the main repo.

Janindu Gayanga · [iamjanindu.com](https://iamjanindu.com) · [LinkedIn](https://www.linkedin.com/in/janindu-gayanga-02ba60217) · janindugayanga10@gmail.com

![Vendor page with the live slot picker](screenshots/03-vendor-page-slots.png)

## What's in it

- A NestJS API for auth, vendors, services, slots, bookings, payments, reviews and admin, plus a public
  GraphQL endpoint for catalogue reads (DataLoader, depth and cost limits, persisted queries).
- A Go service that pushes live slot and booking changes over WebSockets.
- Payments through Stripe (test mode) and PayHere (sandbox) behind one port, with a deterministic fake
  that the tests use. Webhooks land in a separate Express service.
- A transactional outbox and a relay into Redpanda (the Kafka API), idempotent consumers, and
  dead-letter topics that admins can replay.
- BullMQ jobs for refunds, receipt PDFs, reminders, payout batches and a nightly reconciliation.
- MongoDB read models for the vendor activity feed and notification inbox. Money stays in Postgres.
- A Next.js 14 web app, a Helm chart, a local k3d cluster with ArgoCD, and Terraform for one EC2 + K3s
  node.

## The bits worth reading

### Double booking

Four layers. An idempotency key, stored as a unique column in Postgres, is checked before any lock, so
a retried request gets the first answer back. A Redis `SET NX EX` lock is a cheap first filter and
nothing more. The real guarantee is `SELECT ... FOR UPDATE` on the slot inside the transaction, and a
unique `activeSlotId` column is the database backstop. That column is cleared on cancellation, so a freed
slot can be booked again while the cancelled row stays as history.

The transaction started out at `SERIALIZABLE`. The k6 spike showed Postgres aborting bookings for
*different* slots and leaving them unsold, so it now runs at `READ COMMITTED`. That's enough because
every row it decides on is locked explicitly. A test fires 20 parallel bookings at one slot and checks
exactly one wins.

[`samples/api-bookings/`](samples/api-bookings/)

### Never publish from a request handler

"Commit the booking, then publish the event" loses the event if the process dies in between, and
publishing first can announce a booking that rolls back. So the event goes into an outbox table in the
same transaction, and a relay publishes it with `FOR UPDATE SKIP LOCKED`. There's an integration test
that kills the relay before publishing, and again after publishing but before marking the row sent. No
event is lost; the only duplicates are the at-least-once kind the consumers already dedupe.

### Money

Webhooks are verified against the raw body, processed idempotently, and recorded in an append-only
ledger (a trigger rejects `UPDATE`). Commission is in integer basis points. Refunds are reversal
entries, and the vendor is clawed back in the next payout batch. Every night, reconciliation compares
the provider's records with payments and the ledger. A test drops a webhook on purpose and checks the
gap is found and can be repaired.

### The Go hub

One goroutine owns the connection map and everything else talks to it over channels. Every spawned
goroutine recovers from panics, because in Go one unrecovered panic kills the whole process. Slow
clients are dropped instead of blocking the hub. Events arrive through Kafka (a consumer group per
instance), deduped by `eventId` and ordered per slot by version. I haven't load-tested the number of
connections it can hold.

[`samples/realtime-hub/`](samples/realtime-hub/)

## Numbers, including the bad one

- k6 booking spike on k3d: **zero double bookings** at 200 users racing for 20 slots and at 500 for 50.
- The booking latency target (p95 under 300 ms) **was not met**: about 3.2 s at 200 users and 6.0 s at
  500, on one laptop with the API pod CPU-bound. The
  [load test report](docs/LOAD-TEST-REPORT.md) has what I'd
  try next.
- Tests: 201 API unit, 65 API integration on real Postgres, Redis, Redpanda and Mongo, 39 for the
  webhooks service, 51 Go, 25 web unit, 6 Playwright, 11 Helm chart, and 34 `terraform test` runs.

## What "cloud" means here

Nothing runs on a paid account. Kubernetes ran on a local k3d cluster (Helm install, ArgoCD sync from
an in-cluster Gitea, the k6 spike). The Terraform was validated, planned offline and applied only to
LocalStack.

## Screenshots

| | |
|---|---|
| ![Home](screenshots/01-home.png)<br>Home | ![Browse](screenshots/02-vendors-search.png)<br>Browse vendors |
| ![Booking](screenshots/05-booking-flow.png)<br>Booking confirmation | ![Customer](screenshots/06-customer-dashboard.png)<br>Customer dashboard |
| ![Vendor dashboard](screenshots/07-vendor-dashboard.png)<br>Vendor dashboard | ![OpenAPI](screenshots/08-openapi-docs.png)<br>OpenAPI docs |
| ![Mobile home](screenshots/10-mobile-home.png)<br>Mobile | ![Mobile vendor](screenshots/09-mobile-vendor.png)<br>Mobile vendor page |

## Docs

Copies of the main docs are in [`docs/`](docs/): [architecture](docs/01-ARCHITECTURE.md),
[database](docs/02-DATABASE.md) and [security](docs/03-SECURITY.md). The ADRs, SLOs, runbook,
postmortem and cloud lab are in [docs](docs/) (the full set lives in the private repo).

## License

Copyright (c) 2026 Janindu Gayanga. All rights reserved. See [LICENSE](LICENSE).
