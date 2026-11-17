# Backend Platform

One cloud backend for the POS system (POS/Hub sync, owner app, customer app, super-admin).

**Stack:** Node 24 · TypeScript · Fastify 5 · TypeBox · PostgreSQL 17 · Drizzle ORM · Vitest · Docker

## Run locally

Requirements: Node 22+, pnpm 10, Docker Desktop.

```bash
pnpm install
cp .env.example .env
pnpm db:up          # Postgres in Docker on localhost:5434
pnpm db:migrate     # create tables
pnpm dev            # http://localhost:3000/health
pnpm test
```

| Script | What it does |
|---|---|
| `pnpm dev` | Start with hot reload |
| `pnpm test` | Run tests (no database needed) |
| `pnpm typecheck` | TypeScript check |
| `pnpm db:up` | Start local Postgres |
| `pnpm db:generate` | Create a migration after changing `src/db/schema.ts` |
| `pnpm db:migrate` | Apply migrations |
| `pnpm db:studio` | Browse the database in the browser |
| `pnpm db:seed` | Demo café + menu + Hub/POS pairing codes |

## Endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/health` | – | Process alive |
| GET | `/health/ready` | – | Database reachable (503 `DATABASE_DOWN` if not) |
| POST | `/v1/auth/signup` | – | Owner account + business + first branch → tokens |
| POST | `/v1/auth/login` | – | Email + password → tokens (rate limited 10/min/IP) |
| POST | `/v1/auth/refresh` | refresh token | New tokens (rotation; reusing an old one closes all sessions) |
| POST | `/v1/auth/logout` | refresh token | Close this session |
| GET | `/v1/auth/me` | owner | User, business, branches |
| POST | `/v1/owner/branches/:branchId/pairing-codes` | owner (role owner) | New one-time code `{ role: hub\|pos }`, valid 15 min |
| GET | `/v1/owner/branches/:branchId/pairing-codes` | owner | Unused, not expired codes |
| GET | `/v1/owner/branches/:branchId/devices` | owner | Devices with `online` (synced < 60 s), last seen, events received |
| PATCH | `/v1/owner/devices/:deviceId` | owner (role owner) | Rename, disable (POS locked on next sync) or re-enable |
| GET | `/v1/owner/branches/:branchId/menu` | owner | Categories + products (not deleted) |
| POST | `/v1/owner/branches/:branchId/categories` | owner | `{ name, color?, sortOrder? }` |
| PATCH / DELETE | `/v1/owner/categories/:id` | owner | Edit / delete (refused with `CATEGORY_NOT_EMPTY` while it has products) |
| POST | `/v1/owner/branches/:branchId/products` | owner | `{ categoryId, name, price (millimes), vatRateBp?, station?, modifierGroups?, available? }` |
| PATCH / DELETE | `/v1/owner/products/:id` | owner | Edit price, availability, options… / delete |
| POST | `/v1/devices/pair` | pairing code | Pair a POS/Hub → returns `deviceId`, `deviceCode` (T1…), `token` (once) |
| GET | `/v1/devices/me` | device | Check the token is valid / device not disabled |
| POST | `/v1/sync/push` | device | Send up to 500 events (idempotent, gaps recorded) |
| GET | `/v1/sync/pull?cursor=` | device | Menu (categories, products) changed since cursor |

Device auth header: `Authorization: Device <token>`.
Owner auth header: `Authorization: Bearer <accessToken>` (valid 15 min; renew with `/v1/auth/refresh`).

### Owner auth
- Passwords: argon2id, min 10 characters. Emails stored lowercase.
- Access token: JWT (HS256, `JWT_SECRET`), 15 min. Refresh token: random, 30 days, only its hash is stored.
- Wrong password and unknown email return the same `INVALID_CREDENTIALS` (no account guessing).

### Pairing flow
1. Owner app creates a one-time code (`POST /v1/owner/branches/:branchId/pairing-codes`, or `pnpm db:seed` in dev).
2. The POS sends the code + a name + its Ed25519 public key to `/v1/devices/pair`.
3. The server returns a token (shown once, only its hash is stored) and a device code `T1`, `T2`…
4. The POS keeps the token in secure storage and uses it for every sync call.

### Sync rules
- Events are append-only; `id` (UUID v7 from the device) makes retries safe.
- `deviceSeq` increases per device; missing numbers are logged in `sync_errors` (`SEQ_GAP`).
- Events claiming another device/branch are rejected (`WRONG_DEVICE_OR_BRANCH`).
- Pull cursor = server time when the query started → nothing is missed between pulls.
- Menu deletions are soft (`deleted_at`): the next pull returns the row with `deleted: true` so the POS removes it.
- Every menu change sets `updated_at = now()` — that's how the POS sees it.

Errors always look like:
```json
{ "error": { "code": "NOT_FOUND", "message": "Route not found" } }
```

## Structure

```
src/
├── app.ts              builds the app + wires services (used by server and tests)
├── server.ts           starts it
├── config/env.ts       validated env variables
├── plugins/            error handler
├── modules/<feature>/  routes (thin) · schema · service · repo
├── db/                 schema.ts, migrations/, client, migrate
└── shared/             errors, ids
test/                   Vitest + app.inject() with fake repos
```

## Rules
- Routes are thin. Logic in services. Services never import Fastify.
- Only repos talk to the database.
- Money = integer **millimes** (`bigint`), VAT in **basis points**, IDs = **UUID v7**.
- Every business table has `tenant_id` / `branch_id`.
- Never commit `.env` or secrets.
