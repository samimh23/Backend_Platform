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

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | Process alive |
| GET | `/health/ready` | Database reachable (503 `DATABASE_DOWN` if not) |

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
