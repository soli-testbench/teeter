# Plan: Shared Global Leaderboard

## Status: Already Implemented

After thorough codebase exploration, **all 7 acceptance criteria are already fully met** by the existing code. The shared global leaderboard feature was implemented in prior iterations. This plan documents the verification and any minor polish needed.

## Evidence — Acceptance Criteria Mapping

| # | Criterion | Implementation | Location |
|---|-----------|---------------|----------|
| 1 | Scores persisted to shared backend | REST API stores scores in `/data/scores.json` via atomic writes | `api/server.js:244-265` |
| 2 | Leaderboard shows global scores | `GET /api/scores` returns sorted top-10; frontend fetches via API | `js/main.js:93-115`, `api/server.js:341-345` |
| 3 | Players can enter name | Name entry UI with input field, submit button, Enter key support | `index.html:113-155`, `js/main.js:239-258` |
| 4 | localStorage fallback when offline | `loadScoresAsync()` and `addScoreAsync()` fall back to localStorage on network error | `js/main.js:57-170` |
| 5 | Loads within ~2 seconds | `API_TIMEOUT = 2000` (2s abort timeout on fetch) | `js/main.js:54` |
| 6 | Server-side validation | Score: positive integer 1-999999; Name: non-empty, max 15 chars, control chars stripped | `api/server.js:429-450` |
| 7 | Docker/nginx setup | nginx proxies `/api/` → port 3001; Dockerfile installs Node.js; start.sh supervises API | `nginx.conf:37-44`, `Dockerfile`, `start.sh` |

## Additional Security Layers Already Present

- Challenge tokens (one-time, IP-bound, 5-min TTL)
- Rate limiting (3 POST/min/IP)
- Per-IP cooldown (10s between submissions)
- Duplicate detection
- CORS denial (no `Access-Control-Allow-Origin`)
- CSP `connect-src 'self'`
- Server binds `127.0.0.1` only (nginx proxy required)
- Atomic file writes with temp file + rename
- Body size cap (1KB at API, 2KB at nginx)

## Test Suite

43 integration tests pass covering: CRUD operations, validation, challenge tokens, rate limiting, cooldown, concurrent writes, crash recovery, auth modes, read-only mode, and full e2e flows.

## Task

Since all acceptance criteria are already met, the single task is a verification pass: run tests, verify the Docker build, and confirm no regressions. If any minor issues are found during verification, fix them.

## Architecture (Existing)

```
Browser ──→ nginx (:8080) ──→ Node.js API (:3001) ──→ /data/scores.json
  │                               ↑
  └── localStorage fallback ──────┘ (when API unreachable)
```

No external dependencies. No npm packages. Pure Node.js stdlib (http, fs, path, crypto).

## Sources

- Codebase inspection (all files read directly)
- Test suite execution: 43/43 tests passing
