# Busihub

Multi-tenant Point-of-Sale and business management SaaS for small retail
businesses, built primarily for the Ghanaian market on an architecture that
extends to other countries.

**Status: foundation phase.** See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
for the full architecture, folder structure, and phased roadmap — that
document is the source of truth for what exists, what's in progress, and
what's next.

## Stack

Next.js (App Router) + TypeScript + Tailwind CSS on the frontend; Supabase
(PostgreSQL + Auth + Row Level Security + Storage) as the backend; Paystack
for card/mobile-money processing; deployed to Vercel + Supabase.

## Getting started

```bash
npm install
cp .env.example .env.local   # fill in your Supabase project + Paystack keys
npm run db:migrate            # applies supabase/migrations/*.sql to your project
npm run dev
```

Requires a Supabase project (Project Settings → API for the URL/keys,
Project Settings → Database for the connection string used by
`db:migrate`/`db:seed`).

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Start the Next.js dev server |
| `npm run build` | Production build |
| `npm run lint` | ESLint |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | Unit + integration tests (Vitest) |
| `npm run test:e2e` | End-to-end tests (Playwright) |
| `npm run db:migrate` | Apply SQL migrations in `supabase/migrations/` in order |
| `npm run db:seed` | Load development seed data (never run against production) |

## Documentation

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — system architecture, folder structure, roadmap
- [`docs/DATABASE.md`](docs/DATABASE.md) — schema reference
- [`docs/AUTH.md`](docs/AUTH.md) — authentication flows
- [`docs/RBAC.md`](docs/RBAC.md) — roles & permissions model
- [`docs/SECURITY.md`](docs/SECURITY.md) — security controls
- [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) — environment setup & deployment

## Security

Never commit `.env`/`.env.local`. Report suspected security issues to the
project owner directly rather than opening a public issue.
