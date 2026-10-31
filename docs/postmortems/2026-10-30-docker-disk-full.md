# Postmortem: the C: drive filled up and took Docker down

- **Date:** 2026-10-30
- **Duration:** about 1 hour of lost work time (Docker down, then restart and cleanup)
- **Severity:** dev environment only; no user-facing system was involved
- **Status:** resolved, follow-ups below
- **Format:** blameless. The question is what in the setup let this happen, not who did it.

## Summary

While the Phase 3 to 5 work was running in parallel (four git worktrees, each with its
own `node_modules`, plus image builds, Testcontainers and k3d), the C: drive reached 100%.
Docker Desktop keeps its disk image on C:, so the Docker engine crashed. Every container
on the machine stopped, including the databases of other projects running at the same
time. Work in progress was stopped mid-command.

## Impact

- All containers on the laptop stopped (BookLK and three other projects' Postgres, Redis
  and helpers).
- Background agents working in worktrees were stopped; their committed work survived, one
  uncommitted file (`load/booking-spike.js`) was recovered from the worktree by hand.
- No data loss: named volumes survived the crash and the cleanup.

## Timeline (local time)

| Time | Event |
|---|---|
| ~19:10 | Four worktrees active: Terraform, Redux, PACT, k6. Each ran `pnpm install` (about 0.5 to 1 GB of `node_modules` each), the k6 one also a production build. |
| ~19:20 | Terraform tests ran LocalStack; PACT downloaded the FFI library; Testcontainers pulled images. |
| ~19:25 | C: reaches 100%. Docker Desktop's engine stops responding; containers die. |
| ~19:40 | Docker restarted. Stopped containers pruned (volumes kept), build cache cleared. About 24 GB free. |
| ~19:45 | Work resumed **sequentially**, with caches redirected to D: and new disk rules. |

## Root cause

Several things that were each reasonable added up:

1. **Docker's disk lives on C:**, which had about 16 GB free at the start. The project
   files are on D:, so the space used on C: was easy to miss.
2. **Parallel worktrees multiply disk use.** pnpm hard-links from its store, but the store
   is on D: and the worktrees were on D:, while tool caches (Go build cache, npm cache,
   Playwright browsers, temp files) defaulted to `C:\Users\...`.
3. **Build cache and images grow silently.** Nothing warned before the drive was full.
4. **No free-space check** before starting heavy steps (image builds, LocalStack, pulls).

## What went well

- Named volumes and committed work survived; recovering was a restart plus cleanup.
- Small, frequent commits meant almost nothing was lost: only one uncommitted file.

## What went badly

- One shared resource (Docker on C:) failed for **every** project on the machine at once.
- Recovery needed a human: the agents could not see the drive filling up.

## Follow-ups

| Action | Status |
|---|---|
| Point Go, npm, Playwright and temp caches at D: (`GOCACHE`, `GOMODCACHE`, `npm_config_cache`, `PLAYWRIGHT_BROWSERS_PATH`, `TMP`) in every shell | done |
| Check `df -h /c` before pulling or building images; stop if under 10 GB | done (part of the workflow) |
| Work sequentially instead of in parallel worktrees on this machine | done |
| `deploy/k3d/build-images.sh` deletes local images after `k3d image import` and prunes the build cache | done |
| k3d: one server, no agents; the Makefile imports locally cached third-party images instead of pulling them twice | done |
| Move Docker Desktop's disk image to D: (Settings, Resources, Disk image location) | open, needs the owner |
| A small scheduled check that warns at 15% free | open |

## Lessons

- **A shared dependency is a shared failure.** One Docker engine for many projects is the
  laptop version of "one database for every service".
- **Capacity limits need an alert before the limit**, exactly like the SLO burn-rate
  alerts: by the time the disk is full it is too late to react calmly.
