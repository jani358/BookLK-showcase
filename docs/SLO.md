# Service level objectives

UPGRADE-PLAN 5.6. The alert rules are in
[`deploy/helm/booklk/files/prometheus/slo-rules.yaml`](../deploy/helm/booklk/files/prometheus/slo-rules.yaml),
the dashboard in [`deploy/grafana/booklk-overview.json`](../deploy/grafana/booklk-overview.json),
and what to do when one fires in [RUNBOOK.md](RUNBOOK.md).

## Why these two

Booking is the money path: a customer who cannot book leaves, and a vendor who sees a
slow or broken calendar stops trusting the platform. Everything else (feeds, live
updates, receipts) is asynchronous and can lag for a few seconds without anyone losing
money, so it gets alerts but not an SLO.

| SLO | SLI (what we measure) | Target | Window |
|---|---|---|---|
| **Booking availability** | Share of `POST /api/bookings` requests that do **not** return 5xx | **99.5%** | 30 days, rolling |
| **Booking latency** | Share of `POST /api/bookings` requests answered in **under 300 ms** | **95%** (p95 < 300 ms) | 30 days, rolling |

Both are measured at the API (`http_server_request_duration_seconds`, labelled with the
route template). Measuring at the load balancer would also catch API pods that are down
entirely; at our size, the Traefik and API numbers are the same thing, and the API histogram
has the route label we need.

**What counts as good:**
- A **409 "slot already booked" is a success.** Under contention it is the correct answer,
  and the k6 spike produces 450 of them on purpose.
- 4xx caused by the client (400 validation, 401, 403, 429) are good events too: the
  service did its job.
- 5xx and timeouts are bad.

## Error budget

99.5% over 30 days leaves **0.5% of booking requests** to fail. As time: about
**3 h 36 min** of total outage per 30 days.

| Budget left | What we do |
|---|---|
| > 50% | Ship normally. |
| 25-50% | Risky changes (migrations, payment code) need a second reviewer and a rollback plan. |
| < 25% | Feature freeze on the booking path; reliability work only until the budget recovers. |
| Spent | Postmortem, and the fixes from it take priority over features. |

## Alerts (multi-window, multi-burn-rate)

From the Google SRE workbook, chapter 5. "Burn rate" is how fast the budget is being used:
1x spends exactly the monthly budget in 30 days.

| Alert | Condition | Means | Severity |
|---|---|---|---|
| `BookingApiErrorBudgetBurn` | error ratio > 14.4 x 0.5% over **1 h** and over **5 m** | 2% of the monthly budget gone in an hour | page |
| `BookingApiErrorBudgetBurnSlow` | error ratio > 6 x 0.5% over **6 h** and over **30 m** | 5% of the budget in 6 hours | ticket |
| `BookingApiLatencyP95High` | p95 > 300 ms for 10 m (with traffic) | latency SLO at risk | ticket |
| `OutboxBacklogStuck` | oldest unpublished outbox row > 2 min | events not reaching Kafka | page |
| `RealtimeKafkaLagHigh` | hub lag > 1000 messages for 10 m | live updates stale | ticket |
| `PaymentFailureRateHigh` | > 20% of payments failing over 15 m | provider or integration problem | ticket |

The long window makes an alert meaningful (not a blip); the short window makes it clear
quickly once the problem is fixed.

## Load-test evidence

The latency SLO is checked before a release by the k6 spike (`load/booking-spike.js`,
threshold `p(95)<300`). It has been run on a local k3d cluster
([LOAD-TEST-REPORT.md](LOAD-TEST-REPORT.md)):

- **Availability: met in the test.** 0 5xx and 0 double bookings in every run.
- **Latency: not met.** p95 is about **3.2 s** at 200 VUs / 20 slots and **6.0 s** at
  500 VUs / 50 slots, against a 300 ms target. The API pod is CPU-bound on this laptop
  (see the report); the target stays as the goal, and UPGRADE-PLAN 5.3 stays open until
  it is met.

## Limits of this setup

- One Prometheus with 3 days of retention in the dev cluster: the 30-day numbers are
  computed over whatever range the dashboard shows. A real setup keeps 30+ days
  (Prometheus with a PVC, or Grafana Cloud's free tier).
- No Alertmanager is deployed: alerts are visible in the Prometheus UI (`/alerts`). Routing
  pages to a phone is one Alertmanager config away and is not needed on a laptop.
