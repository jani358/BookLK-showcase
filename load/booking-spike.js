// k6 booking spike (UPGRADE-PLAN 5.3): 500 virtual users race for 50 slots.
//
// Seed first (writes load/.data/run.json), then:
//   k6 run -e BASE_URL=http://localhost:3187/api load/booking-spike.js
// and check Postgres afterwards with `pnpm load:verify` (apps/api).
// See load/README.md.
import http from 'k6/http';
import { check } from 'k6';
import { Counter, Trend } from 'k6/metrics';
import { SharedArray } from 'k6/data';
import exec from 'k6/execution';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3187/api';
const RUN_FILE = __ENV.RUN_FILE || './.data/run.json';
const VUS = Number(__ENV.VUS || 500);
// Each VU keeps trying other slots until it wins one or runs out of attempts.
const ATTEMPTS = Number(__ENV.ATTEMPTS || 3);
// Through an Ingress on 127.0.0.1 (e.g. k3d's Traefik on :8180), set the Host
// header the Ingress routes on: -e HOST_HEADER=booklk.localhost
const HOST_HEADER = __ENV.HOST_HEADER || '';

// Parsed once and shared read-only between VUs.
const run = new SharedArray('run', () => [JSON.parse(open(RUN_FILE))]);

const created = new Counter('bookings_created');
const conflicts = new Counter('bookings_conflict');
const serverErrors = new Counter('bookings_5xx');
const otherErrors = new Counter('bookings_other_error');
const bookingDuration = new Trend('booking_duration', true);

export const options = {
  scenarios: {
    spike: {
      // Every VU starts at once and runs one iteration: a single burst of
      // 500 customers, the "slots just opened" moment.
      executor: 'per-vu-iterations',
      vus: VUS,
      iterations: 1,
      maxDuration: '2m',
    },
  },
  thresholds: {
    'http_req_duration{name:create_booking}': ['p(95)<300'],
    bookings_5xx: ['count==0'],
    bookings_other_error: ['count==0'],
    // Every slot gets taken (50), and never more than there are slots.
    bookings_created: [`count<=${run[0].slotIds.length}`, `count>=${run[0].slotIds.length}`],
    checks: ['rate==1'],
  },
  summaryTrendStats: ['min', 'med', 'avg', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

export default function () {
  const { slotIds, tokens, runId } = run[0];
  const vu = exec.vu.idInTest; // 1-based
  const token = tokens[(vu - 1) % tokens.length];
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
  if (HOST_HEADER) headers.Host = HOST_HEADER;

  // Start at a random slot and walk forward: heavy contention on every slot.
  const start = Math.floor(Math.random() * slotIds.length);

  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const slotId = slotIds[(start + attempt) % slotIds.length];
    const res = http.post(
      `${BASE_URL}/bookings`,
      JSON.stringify({ slotId, idempotencyKey: `load-${runId}-${vu}-${attempt}` }),
      // 409 is an expected outcome under contention, not a failed request.
      { headers, tags: { name: 'create_booking' }, responseCallback: http.expectedStatuses(201, 409) },
    );
    bookingDuration.add(res.timings.duration);

    check(res, { 'status is 201 or 409': (r) => r.status === 201 || r.status === 409 });

    if (res.status === 201) {
      created.add(1);
      return;
    }
    if (res.status === 409) {
      conflicts.add(1);
      continue;
    }
    if (res.status >= 500) serverErrors.add(1);
    else otherErrors.add(1);
    console.error(`VU ${vu}: unexpected ${res.status} ${res.error_code} ${res.error || res.body}`);
    return;
  }
}
