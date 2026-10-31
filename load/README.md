# Load tests (k6)

UPGRADE-PLAN 5.3. Results and the bottleneck that was found: [docs/LOAD-TEST-REPORT.md](../docs/LOAD-TEST-REPORT.md).

| Script | What it does |
|---|---|
| `booking-spike.js` | Every VU starts at once and tries to book (up to 3 slots each). Thresholds: no 5xx, no other errors, exactly as many bookings as slots, p95 < 300 ms. 409 is an expected answer, not an error. |
| `smoke.js` | One booking, an idempotent replay, and a 409 for a second customer, on the extra smoke slot. |

## Run it against the k3d cluster

```bash
# 1. Reach the in-cluster Postgres (any free local port)
kubectl -n booklk port-forward svc/booklk-postgres 4185:5432 &

# 2. Seed: a fresh vendor + slots, customers, one signed token each -> load/.data/run.json (gitignored)
cd apps/api
DATABASE_URL=postgresql://booklk:booklk_dev@localhost:4185/booklk \
JWT_SECRET=dev_access_secret_change_me_0123456789 \
LOAD_SLOTS=20 LOAD_CUSTOMERS=200 pnpm load:seed

# 3. Spike through Traefik, exactly as a browser would (Host header picks the Ingress)
cd ../../load
k6 run -e BASE_URL=http://127.0.0.1:8180/api -e HOST_HEADER=booklk.localhost -e VUS=200 booking-spike.js

# 4. Check Postgres directly: zero double bookings
cd ../apps/api
DATABASE_URL=postgresql://booklk:booklk_dev@localhost:4185/booklk pnpm load:verify
```

`JWT_SECRET` must be the value the API runs with (`values-k3d.yaml` for the lab). Tokens are
signed by the seed instead of logging in, because login is bcrypt plus a 10/min rate limit
and the test is about booking.

Against a local API instead of the cluster: `BASE_URL=http://localhost:3187/api`, no
`HOST_HEADER`, and the compose database URL.

## Knobs

| Variable | Default | Where |
|---|---|---|
| `VUS` | 500 | k6, number of customers in the burst |
| `ATTEMPTS` | 3 | k6, slots each VU tries before giving up |
| `LOAD_SLOTS` | 50 | seed |
| `LOAD_CUSTOMERS` | 500 | seed, should be >= `VUS` (the booking route is rate limited per user) |

Each seed run makes a new vendor and slots, so runs never interfere. `load:verify` checks the
slots of the last seed run.
