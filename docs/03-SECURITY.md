# 03 — Security

BookLK handles authentication, personal data, and money. This document states the threat
model, explains each control and the attack it stops, walks the OWASP Top 10, and lists
what is deliberately **not** implemented.

The last section matters as much as the rest. A security document that claims everything
is covered is not credible.

---

## 1. Threat model

**What is worth attacking:**

| Asset | Why an attacker wants it | Worst case |
|---|---|---|
| User credentials | Reuse against other services | Account takeover, cascading breaches |
| Session tokens | Impersonation without a password | Full account access |
| Payment flow | Free services, or fraudulent refunds | Direct financial loss |
| Vendor data | Competitor intelligence; PII of customers | Regulatory exposure, reputational loss |
| Booking inventory | Denial of service on a competitor | Vendor loses a day of revenue |
| Payout account details | Redirect vendor money | Theft |

**Who is attacking:**

| Actor | Capability | Realistic goal |
|---|---|---|
| Opportunistic scanner | Automated, high volume, no persistence | Known CVEs, default creds, exposed `.env` |
| Credential stuffer | Large breach corpora, botnet | Account takeover at scale |
| Malicious customer | Valid account, reads the API | Book without paying, force refunds, scrape vendors |
| Malicious vendor | Valid vendor account | Read other vendors' bookings, inflate own payouts |
| Insider / leaked dump | Read access to the database | Extract passwords, replay sessions |

**Trust boundaries:**

```
 UNTRUSTED                            │ TRUSTED
                                      │
 Browser JS                           │  apps/api process
 Mobile client                        │  apps/realtime process
 Webhook POST from "the provider" ────┼──► only after HMAC verification
 Any request body / header / param    │  Postgres, Redis (private network)
 Any client-supplied ID or price      │
```

The operative rule: **anything crossing that line is hostile until proven otherwise.** A
JWT is untrusted until its signature verifies. A webhook is untrusted until its HMAC
verifies. A price in a request body is never trusted at all — it is read from the database.

**Explicitly out of scope:** DDoS absorption (a CDN/WAF's job), physical security, host
OS hardening, supply-chain attacks on npm/Go modules beyond committed lockfiles
(`pnpm install --frozen-lockfile` in CI; there is no `audit` step in CI yet).

---

## 2. Authentication design

### Why JWT and not server-side sessions

Honest framing: **sessions are the better default for most single-server apps.** They are
revocable instantly, smaller, and simpler. JWT is chosen here for a specific reason:

The Go realtime service must authenticate WebSocket connections. With server-side
sessions, Go would need to query the session store on every connect — a network hop, a
shared dependency, and a coupling between two services in two languages. With a JWT, Go
verifies an HMAC signature locally using a shared secret and knows the user's ID and role
in microseconds, with no network call.

The trade-off is real and must be stated: **a JWT cannot be revoked before it expires.**
The mitigation is to make that window small — 15 minutes — and to hold revocable state in
the refresh token instead.

| | Session cookie | JWT (as used here) |
|---|---|---|
| Revocation | Immediate | Only at expiry (15 min max) |
| Verification | Store lookup | Local signature check |
| Cross-service | Needs a shared store | Needs a shared secret |
| Horizontal scale | Sticky sessions or shared store | Stateless |
| Size | ~32 bytes | ~300–500 bytes on every request |

### Why 15-minute access tokens

Directly balancing two costs:

- **Longer** (say 24h): a stolen token is usable for 24 hours. Logging out, changing a
  password, or banning a user does nothing until it expires.
- **Shorter** (say 1 min): a refresh round-trip every minute; more load, more edge cases,
  worse UX on flaky networks.

Fifteen minutes bounds the damage from a leaked access token to a quarter of an hour while
keeping refresh traffic negligible. If a token leaks at 14:00, it is dead by 14:15 with no
action needed by anyone.

Token contents — deliberately minimal:

```json
{
  "sub": "9f3c…",          // user id
  "role": "CUSTOMER",      // for fast RBAC without a DB hit
  "vendorId": "b71a…",     // present only for VENDOR, scopes tenant queries
  "iat": 1767225600,
  "exp": 1767226500,
  "jti": "0f1e…"           // unique id, enables targeted denylisting if ever needed
}
```

No email, no name, no PII. **A JWT is signed, not encrypted** — anyone can base64-decode
and read the payload. Putting personal data in a JWT means putting it in every browser's
network log and every proxy that sees the header.

### Refresh tokens: hashed at rest

Refresh tokens are long-lived (7 days) and therefore far more valuable than access tokens.

**They are stored as a hash, never in plaintext.** The client holds the raw token; the
database holds only `token_hash`. On refresh, the presented token is hashed and compared.

The reason is the leaked-dump scenario. With plaintext refresh tokens, an attacker with a
read-only database dump — via SQL injection, a misconfigured backup bucket, or a bad
backup restore — gets working sessions for every logged-in user, and password rotation
does not help. With hashes, they get nothing usable.

SHA-256 is sufficient here (unlike passwords, which need bcrypt). A refresh token is 32
bytes of cryptographic randomness — there is no dictionary to attack and no rainbow table
to build, so the slow-hashing property that matters for human-chosen passwords buys
nothing, and per-request refresh latency does matter.

### Rotation + reuse detection

**Every refresh issues a new refresh token and immediately invalidates the old one.**

```
Login
  └─► family F1
      RT1 (active)

POST /auth/refresh with RT1
  ├─ RT1 → revoked, replaced_by = RT2
  └─► RT2 (active), same family F1

POST /auth/refresh with RT2
  ├─ RT2 → revoked, replaced_by = RT3
  └─► RT3 (active), same family F1
```

Rotation alone shrinks the window. **Reuse detection is what turns theft into detection:**

```
Attacker steals RT2 (XSS on another site, malware, shoulder-surfed device).

Case A — attacker uses it first:
  attacker: refresh(RT2)  → RT2 revoked, attacker gets RT3
  victim:   refresh(RT2)  → RT2 IS ALREADY REVOKED
                             ↳ REUSE DETECTED
                             ↳ revoke EVERY token in family F1, including RT3
                             ↳ both parties forced to re-login
                             ↳ attacker's stolen session is dead
                             ↳ alert raised on the account

Case B — victim uses it first:
  victim:   refresh(RT2)  → RT2 revoked, victim gets RT3
  attacker: refresh(RT2)  → ALREADY REVOKED
                             ↳ same outcome, attacker never gets in
```

**The attack this stops:** silent, persistent session hijacking. Without rotation, a
stolen refresh token grants indefinite access and nothing ever indicates a breach — the
victim keeps working normally while the attacker rides alongside. With rotation and reuse
detection, a stolen token is guaranteed to be detected the moment *either* party refreshes,
which for an active user is within 15 minutes. The system converts an invisible compromise
into a loud one.

`family_id` is what makes revocation complete. Revoking only the reused token would leave
whichever descendant the attacker just obtained valid. Killing the whole family is
correct, even though the honest user is logged out too — a forced re-login is a small
price for terminating a live compromise.

**Known false positive:** a client that fires two refreshes concurrently (two tabs, a
retried request) can trigger reuse detection legitimately. Mitigations: a small grace
window (accept the immediately-preceding token for ~10 seconds), and single-flight
refresh on the client so concurrent 401s share one refresh promise. This project uses
client-side single-flight; the grace window is noted in §10 as not yet implemented.

### Password storage: bcrypt, cost 12

```ts
const hash = await bcrypt.hash(plaintext, 12);
const ok   = await bcrypt.compare(candidate, hash);
```

**Why not MD5 or SHA-256?** They are built to be *fast* — the exact opposite of what
password hashing needs. Commodity GPU hardware computes billions of SHA-256 hashes per
second, so a leaked table of SHA-256 password hashes is effectively a leaked table of
passwords for anything but a long random string. MD5 additionally has practical collision
attacks and has been unfit for any security use for two decades.

**Why bcrypt.** It is deliberately slow and memory-touching, so GPUs get far less
advantage. It salts automatically — the salt is embedded in the output — so identical
passwords produce different hashes and rainbow tables are useless. And it has a tunable
cost factor, so it can be made slower as hardware gets faster.

**Why cost 12.** Cost is a power of two of iterations; each +1 doubles the work. Cost 12 is
roughly 250–350 ms on typical server hardware. That is unnoticeable on a login (which
happens once) and brutal for an attacker (a few hundred guesses per second per core
instead of billions). Cost 10 is the common default and now on the low side; cost 14 (~1 s)
starts making login feel broken and turns the login endpoint into a self-DoS vector.

**Note on argon2id:** it is the current recommendation and is memory-hard, which resists
GPU and ASIC attacks better than bcrypt. bcrypt at cost 12 is chosen here for its
maturity and zero-friction Node story; argon2id would be a straightforward upgrade and is
the right choice for a greenfield system with an ops team.

Also enforced: constant-time comparison (`bcrypt.compare` handles this), and **identical
responses and timing for "unknown email" and "wrong password"** — otherwise the login
endpoint becomes an account-enumeration oracle.

---

## 3. Authorization

### RBAC design

Three roles, enforced by a NestJS guard:

| Role | Can |
|---|---|
| `CUSTOMER` | Browse vendors/slots, create/cancel own bookings, review own completed bookings |
| `VENDOR` | Manage own vendor profile, services, slots; read own bookings; read own payouts |
| `ADMIN` | Everything, plus vendor approval/suspension and refund overrides |

```ts
@Roles(Role.VENDOR)
@UseGuards(JwtAuthGuard, RolesGuard)
@Patch('services/:id')
updateService(@CurrentUser() user: JwtUser, @Param('id') id: string, @Body() dto: UpdateServiceDto) {
  // Guard proved the ROLE. It did not prove OWNERSHIP.
  return this.servicesService.update(id, dto, user.vendorId);
}
```

**Role is not ownership, and conflating them is the most common real-world authorization
bug.** `RolesGuard` proves this caller is *a* vendor. It says nothing about whether they
own service `:id`. The service layer must scope every query by the caller's `vendorId`:

```ts
async update(id: string, dto: UpdateServiceDto, vendorId: string) {
  // vendorId in the WHERE — not a fetch-then-compare.
  const result = await this.prisma.service.updateMany({
    where: { id, vendorId },     // wrong vendor ⇒ zero rows, not an edit
    data: dto,
  });
  if (result.count === 0) throw new NotFoundException();
  return this.findOne(id, vendorId);
}
```

Two details worth defending:

- **The tenant filter is in the `WHERE` clause, not an `if` after fetching.** Fetch-then-
  compare works until someone adds an early return, and it leaks existence through timing
  and error-shape differences.
- **`NotFoundException`, not `ForbiddenException`.** `403` confirms the resource exists,
  turning the endpoint into an enumeration oracle. `404` reveals nothing.

`vendorId` comes from the **signed JWT**, never from a request body, query parameter, or
header. Full treatment in `05-SAAS-MODEL.md` §3.

### Why authorization is always server-side

The frontend hides the "Cancel booking" button for bookings that are not yours. That is
**UX, not security**. Anyone can open DevTools, read the network tab, and issue the
`DELETE` themselves — or skip the browser entirely and use `curl`.

Every client-side check must be duplicated server-side, because:

1. The client is fully controlled by the attacker. Its code, its state, its requests.
2. The API is a public interface whether or not it is documented as one.
3. Mobile apps, scripts, and the Swagger UI at `/docs` all hit the same endpoints without
   ever loading the React app.

The correct mental model: the frontend decides what to *show*; the backend decides what is
*allowed*. If those two disagree, the backend wins and the user sees an error — which is
the safe failure direction.

---

## 4. Rate limiting

Redis sliding-window counters, applied per endpoint class.

| Endpoint | Limit | Key | Why |
|---|---|---|---|
| `POST /auth/login` | 5 / 15 min | IP **and** email | Credential stuffing |
| `POST /auth/register` | 3 / hour | IP | Fake-account floods |
| `POST /auth/refresh` | 30 / 15 min | user id | Bounds a compromised-token loop |
| `POST /bookings` | 10 / min | user id | Booking-inventory spam |
| `GET /vendors`, `GET /slots` | 100 / min | IP | Scraping |
| Global fallback | 300 / min | IP | Backstop |

**Sliding window over fixed window.** A fixed window resets on a boundary, so an attacker
sends the full quota at 14:59:59 and again at 15:00:00 — double the intended rate at the
seam. A sliding window counts requests in the trailing N seconds and has no seam.

**Keying on both IP and email for login is deliberate.** IP-only fails against a botnet
spreading one password across thousands of IPs. Email-only lets an attacker lock a known
victim out of their own account (a DoS). Both together: a distributed attack still trips
the per-email limit, and a targeted lockout still leaves the victim's own IP unaffected
for other accounts.

**Why Redis and not in-memory.** With three API pods, in-memory counters give an attacker
3× the intended limit and produce inconsistent behaviour depending on which pod the load
balancer picks. Redis is the shared source of truth, and `INCR`+`EXPIRE` is atomic.

Responses return `429` with `Retry-After` and `X-RateLimit-*` headers. Legitimate clients
back off; attackers learn nothing they could not measure anyway.

**Limitation, stated:** this is application-layer limiting. It cannot absorb a volumetric
DDoS — those packets still reach the process. That is a CDN/WAF job (Cloudflare in front),
noted in §10.

---

## 5. Webhook signature verification

The payment provider POSTs to `/payments/webhook` when a charge succeeds. **That endpoint
is public** — the provider must be able to reach it, so it cannot sit behind JWT auth.

### Why an unverified webhook is critical

Without verification, this is the entire attack:

```bash
curl -X POST https://api.booklk.lk/payments/webhook \
  -H 'Content-Type: application/json' \
  -d '{"type":"payment.succeeded","data":{"paymentId":"<any id>","amount":500000}}'
```

The API marks the payment `SUCCEEDED`, confirms the booking, and queues a vendor payout.
The attacker paid nothing. The platform pays the vendor real money out of its own float.
Repeat in a loop and the platform is drained. This is not a theoretical severity rating —
it is unauthenticated, remotely exploitable, direct financial loss, and it has happened to
real companies.

### The implementation

The provider signs the **raw request body** with a shared secret:

```
signature = HMAC-SHA256(secret, timestamp + "." + rawBody)
header:     X-Signature: t=1767225600,v1=5d41402abc4b2a76b9719d911017c592
```

Verification, in order:

```ts
// 1. RAW body. Parsing to an object first and re-serialising changes key order and
//    whitespace, and the signature will never match. Requires rawBody middleware on
//    this route specifically.
const signed = `${timestamp}.${rawBody}`;
const expected = crypto.createHmac('sha256', secret).update(signed).digest('hex');

// 2. Timing-safe comparison. A byte-by-byte `===` short-circuits on the first
//    mismatch; the timing difference is measurable over enough requests and leaks
//    the signature one byte at a time.
const ok = crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(received));
if (!ok) { await recordFailure(); throw new UnauthorizedException(); }

// 3. Timestamp freshness — reject anything older than 5 minutes. Without this, a
//    signature captured once (from logs, a proxy, a misconfigured mirror) replays
//    forever, because a valid signature stays valid.
if (Math.abs(Date.now()/1000 - timestamp) > 300) throw new UnauthorizedException();

// 4. Dedupe on provider_event_id — providers retry by design and WILL deliver
//    duplicates. UNIQUE constraint on webhook_events.provider_event_id.

// 5. Only now: apply the event.
```

All five steps are load-bearing. Skipping raw-body handling breaks it functionally;
skipping timing-safe comparison, freshness, or dedupe breaks it *silently and securely*
— it still works, it is just exploitable.

**Failures are recorded, not swallowed.** `webhook_events.signature_ok = false` with an
alert on any spike. Failed signatures mean one of: a rotated secret not yet deployed, a
proxy mangling the body, or an active forgery attempt.

**Never trust amounts from the webhook payload.** The webhook says *which* payment
succeeded. The amount is read from the local `payments` row. Otherwise a forged-but-
signed replay could alter the amount.

---

## 6. Idempotency as a security control

Idempotency is usually framed as reliability. It is also a security control, and both
framings are worth having ready.

**Reliability framing:** mobile networks drop responses. A client that gets no response
retries. Without idempotency, the retry creates a second booking and a second charge.

**Security framing:** without idempotency, "send the same request many times" is a
*primitive* an attacker can use:

| Endpoint | Replay attack without idempotency |
|---|---|
| `POST /bookings` | Exhaust a vendor's inventory with duplicate bookings |
| `POST /payments/refund` | Trigger multiple refunds for one booking — direct theft |
| `POST /payments/webhook` | Replay a captured `payment.succeeded` to confirm many bookings |

The refund case is the sharpest. A refund endpoint without idempotency means one
legitimate cancellation, replayed twenty times, pays out twenty times.

**Implementation:** the key is a UNIQUE column in Postgres on the row it creates
(`Booking.idempotencyKey`, `Payment.idempotencyKey`, `Refund.idempotencyKey`). There is
no Redis entry and no TTL.

```
Client sends:  { ..., "idempotencyKey": "<uuid v4, generated once per user intent>" }  (JSON body)

Server (POST /api/bookings):
  1. SELECT the booking WHERE idempotencyKey = key
  2. Found, same customer   → return that booking (no lock, no new transaction)
     Found, other customer  → 409 "Idempotency key already used"
  3. Not found              → normal create path; the INSERT carries the key
  4. Two first attempts race with one key → only one INSERT can succeed; the other
     hits the unique index (P2002 → 409)
```

Details that matter:

- **The key is checked against its owner.** A booking key replayed by another user is
  rejected, so a guessed key never hands out someone else's booking. A payment key reused
  for a different booking is rejected too.
- **The key is generated once per user intent** (held in a `useRef` in the web app) —
  not per HTTP attempt. Regenerating per attempt defeats the entire mechanism.
- **Keys never expire.** They live on the row, so a retry days later still finds the
  original. The cost is one unique index per table.
- **Concurrent duplicates are handled by the database**, not just sequential retries:
  two simultaneous submits from a double-clicked button cannot both insert.

Same request + same key = same result, once. That is the invariant.

---

## 7. OWASP Top 10 (2021) walkthrough

### A01 — Broken Access Control
*The most common serious vulnerability, and the one this codebase spends the most effort on.*
- Every tenant-scoped query filters by `vendorId` from the JWT in the `WHERE` clause.
- `404`, not `403`, for cross-tenant access — no existence oracle.
- No IDOR: `/bookings/:id` verifies the booking belongs to the caller before returning it.
- `@Roles()` on every non-public route; the default is denied, and a route with no explicit
  decorator is authenticated-only.
- Integration tests assert cross-tenant access fails. An access-control rule with no test
  is a rule that will regress.

### A02 — Cryptographic Failures
- bcrypt cost 12 for passwords; SHA-256 for refresh tokens (both hashed at rest).
- TLS everywhere in production; HSTS via Caddy/ingress.
- Separate secrets for access and refresh tokens, so a leaked access secret cannot mint
  refresh tokens.
- No PII in JWTs (signed ≠ encrypted).
- Never storing raw card data or bank details — only opaque provider references.

### A03 — Injection
- Prisma parameterises everything. The one raw SQL statement (`SELECT ... FOR UPDATE`)
  uses `$queryRaw` with tagged-template parameters, never string concatenation.
- `class-validator` + `ValidationPipe` with `whitelist: true` and
  `forbidNonWhitelisted: true` — unknown properties are stripped or rejected, which also
  blocks mass-assignment (§A08).
- Output escaping: React escapes by default; no `dangerouslySetInnerHTML` on user content.

### A04 — Insecure Design
- The double-booking defence is layered by design (Redis lock → row lock → unique
  constraint) rather than relying on one mechanism.
- Money is append-only and reconciled, so errors are detectable rather than silent.
- Slot `HELD` state exists specifically to close a business-logic race — a design fix, not
  a code fix.
- Rate limiting designed in from the start rather than added after an incident.

### A05 — Security Misconfiguration
- `helmet` for security headers.
- CORS is an explicit allowlist (§9), never `*` with credentials.
- Stack traces never returned in production; a global exception filter returns a generic
  message and logs the detail with a correlation ID.
- Config validated at boot with Joi — the app refuses to start with a missing or default
  secret in production rather than running insecurely.
- Swagger at `/docs` is disabled or auth-gated in production.
- Containers run as a non-root user.

### A06 — Vulnerable and Outdated Components
- Lockfiles committed and installed with `--frozen-lockfile` in CI.
- **Not built yet:** `pnpm audit` / `govulncheck` in CI and Dependabot. Run `pnpm audit`
  and `govulncheck ./...` by hand until they are added.
- Pinned base image tags (`node:22-alpine`, `node:20-alpine`, `golang:1.23-alpine`, distroless), not `latest`.
- Honest note: this is only as good as the cadence of actually merging the PRs.

### A07 — Identification and Authentication Failures
- Rate-limited login with identical responses for unknown-email and wrong-password.
- Short access tokens; rotating refresh tokens with reuse detection.
- Password minimum 12 characters, checked against a common-password list. **No composition
  rules** (no "must contain a symbol") — NIST 800-63B dropped them because they push users
  toward `Password1!` while reducing entropy.
- Sessions invalidated on password change (revoke all refresh-token families).
- **Missing: 2FA.** See §10.

### A08 — Software and Data Integrity Failures
- Webhook HMAC verification (§5) is exactly this control.
- DTO whitelisting prevents mass assignment — a client cannot set `role: "ADMIN"` or
  `commissionBps: 0` by adding fields to a request body.
- CI builds from a pinned commit; images are tagged by digest for deploy.

### A09 — Security Logging and Monitoring Failures
- Logged: login success/failure, refresh reuse detection, webhook signature failures,
  rate-limit trips, all `4xx`/`5xx` on money endpoints, admin actions.
- Structured JSON logs with a correlation ID threaded through the request.
- **Never logged: passwords, tokens, full request bodies on auth or payment routes.** A
  log aggregator is a lower-security environment than the database, and secrets in logs
  have caused more breaches than clever cryptanalysis.
- Sentry for exceptions; Prometheus alerts on auth-failure and webhook-failure rates.

### A10 — Server-Side Request Forgery
- Limited surface: the API makes no outbound requests to user-supplied URLs.
- Vendor-supplied image URLs are validated against an allowlist of hosts and never fetched
  server-side. If server-side fetching is ever added (thumbnailing), it needs a URL
  allowlist, blocked private IP ranges including link-local `169.254.169.254`, and no
  redirect following.

---

## 8. Secrets management

**Never in git.** `.env` is gitignored; `.env.example` documents every variable with a
placeholder and is committed.

| Environment | Where secrets live |
|---|---|
| Local | `.env`, gitignored, dev-only values |
| CI | GitHub Actions encrypted secrets, masked in logs |
| Production (VPS) | `.env` on the host, `chmod 600`, root-owned, outside the repo |
| Production (K8s) | Kubernetes `Secret` (sealed-secrets or External Secrets Operator) |
| Production (managed PaaS) | Provider's secret store |

**Rules:**

1. Different secrets per environment. Sharing a dev secret into production means the
   secret's blast radius is every laptop that ever cloned the repo.
2. Access and refresh secrets are distinct (see the comment in `apps/api/.env.example`).
3. Rotation must be possible without downtime: accept both old and new secret during a
   rotation window, then drop the old one.
4. Boot-time validation refuses to start in production if any secret is missing or still
   matches a known default.
5. **If a secret is committed, rotate it.** Rewriting git history does not help — assume
   it was scraped within minutes. GitHub's push protection catches common formats, not
   custom ones.

Both `JWT_SECRET` and `PAYMENT_WEBHOOK_SECRET` need at least 32 bytes of real entropy:

```bash
openssl rand -base64 48
```

---

## 9. CORS and WebSocket origin checking

### CORS

```ts
app.enableCors({
  origin: process.env.CORS_ORIGINS.split(','),   // explicit allowlist
  credentials: true,                              // required for the refresh cookie
  methods: ['GET','POST','PATCH','DELETE'],
  allowedHeaders: ['Content-Type','Authorization','Idempotency-Key'],
  maxAge: 86400,
});
```

**Never `origin: '*'` with `credentials: true`.** Browsers reject that combination
outright, and libraries that "helpfully" reflect the request origin instead recreate the
vulnerability the spec was preventing: reflection means *every* site is allowed, and any
page on the internet can make credentialed requests to the API with the victim's cookie.

Also worth being clear about: **CORS is not an authorization mechanism.** It restricts what
*browsers* allow one origin's JavaScript to do. `curl`, Postman, and any server-side
script ignore it entirely. CORS protects the user's browser session; it does not protect
the API. The API is protected by authentication and authorization.

### WebSocket origin checking

The browser does not enforce CORS on WebSocket upgrades. **The server must check `Origin`
itself** — this is `CheckOrigin` in the Go hub, backed by `ALLOWED_ORIGINS` in
`apps/realtime/internal/config`.

Without it: any website can open a WebSocket to the realtime service from a victim's
browser. That is Cross-Site WebSocket Hijacking, and if the connection authenticated via a
cookie it would be a full session hijack.

Two defences, layered:

1. **Explicit origin allowlist**, never a `return true` default. The config layer refuses
   to start with an empty `ALLOWED_ORIGINS`, which is why that validation exists in
   `config.go`.
2. **JWT in the connect message or a query parameter, not a cookie.** Cookies are sent
   automatically by the browser and are therefore CSWSH-able. A token the JavaScript must
   deliberately attach is not.

`ALLOW_ANONYMOUS=true` permits token-less read-only subscription to public availability,
which is genuinely not secret. The config's `validate()` refuses to start when
`ALLOW_ANONYMOUS=false` and no `JWT_SECRET` is set — silently accepting unsigned tokens
would be a complete auth bypass, and failing loudly at boot is the correct behaviour.

Also on the WebSocket path: `MAX_MESSAGE_SIZE` (4 KB default) caps inbound frames so a
client cannot exhaust server memory with one giant message, and per-connection send
buffers with a slow-consumer drop policy prevent one client from degrading everyone else.

---

## 10. Deliberately NOT implemented (yet)

Being explicit about gaps is more credible than claiming completeness. Each entry has a
reason and a rough cost.

| Gap | Why not yet | Risk accepted | Effort to add |
|---|---|---|---|
| **2FA / TOTP** | Meaningful UX and recovery-flow work (backup codes, "lost my phone" support). Not justified before real users. | Credential stuffing succeeds if a password leaks. Mitigated by rate limiting and short tokens, not eliminated. | ~2 days incl. recovery codes |
| **Strict CSP** | A tight `Content-Security-Policy` needs nonce plumbing through Next.js and breaks inline styles/scripts until every violation is chased down. Currently helmet's defaults, no strict CSP. | XSS impact is larger than it needs to be. Partly mitigated: no long-lived token in JS-readable storage. | ~1 day + a week of report-only tuning |
| **Email verification enforced** | Column exists; not gated on all flows. | Fake accounts; unverified emails receiving booking data. | ~half a day |
| **Account lockout after N failures** | Rate limiting only. Lockout is itself a DoS vector against known accounts. | Slow persistent guessing is throttled but not stopped. | ~half a day, needs care |
| **Field-level encryption for PII** | Phone numbers and addresses are plaintext in the DB. Disk encryption only. | A DB dump exposes contact details. | ~2 days incl. key management |
| **WAF / DDoS protection** | Application-layer rate limiting only. | Volumetric attacks reach the origin. | Cloudflare in front — hours, not days |
| **Audit log for admin actions** | Admin changes are logged to stdout, not to a queryable append-only table. | Weak accountability for privileged actions. | ~1 day |
| **Automated pen-test / DAST in CI** | No OWASP ZAP or similar in the pipeline. | Regressions found by reading, not by scanning. | ~1 day |
| **Secret scanning pre-commit** | Relies on GitHub push protection. | A custom-format secret could land in history. | ~1 hour (gitleaks hook) |
| **Refresh grace window** | Concurrent refresh handled client-side by single-flight only. | A double-refresh race can force an unnecessary re-login. | ~2 hours |

**The prioritised order if this went to production tomorrow:** Cloudflare in front (cheapest
risk reduction per hour), enforced email verification, 2FA for vendors and admins (they
control money), then CSP.

---

## 11. Security checklist before any production deploy

```
[ ] All secrets rotated from dev values; none match .env.example
[ ] JWT_SECRET and JWT_REFRESH_SECRET are distinct, >= 32 bytes of entropy
[ ] PAYMENT_WEBHOOK_SECRET set and matches the provider dashboard
[ ] CORS_ORIGINS lists only real production origins; no wildcard
[ ] ALLOWED_ORIGINS set for the realtime service; ALLOW_ANONYMOUS reviewed
[ ] NODE_ENV=production (disables stack traces, enables prod-only paths)
[ ] Swagger /docs disabled or behind auth
[ ] TLS terminating correctly; HSTS on; HTTP redirects to HTTPS
[ ] Postgres and Redis NOT exposed on public ports
[ ] Redis password set (default config has none)
[ ] Containers run as non-root
[ ] Database backups running AND a restore has actually been tested
[ ] Sentry DSN set; a test error confirmed to arrive
[ ] Alerts configured: auth failure rate, webhook signature failures, 5xx rate
[ ] pnpm audit / govulncheck clean of high and critical
[ ] Rate limits verified against the live deployment, not just locally
```
