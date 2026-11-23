# ClinicStock

Inventory and expiry tracking for a small clinic: batches, FEFO issuing,
append-only movement history, and per-clinic isolation enforced by PostgreSQL
RLS. Next.js static export, Supabase, deployed on Cloudflare.

**Demo only, with synthetic data.** Not a production clinical system.

```bash
npm install
npm run dev            # http://localhost:3000 (demo mode needs no backend)
npm test               # domain, repository, database and concurrency suites
npm run build && npm run deploy
```

Docs:

- [Architecture](docs/ARCHITECTURE.md)
- [Database and security model](docs/DATABASE.md)
- [Test traceability](docs/TEST-TRACEABILITY.md)
- [Deployment](docs/DEPLOYMENT.md)
- [Roadmap](docs/ROADMAP.md)
