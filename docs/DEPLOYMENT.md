# Deployment (Milestone 8)

Live demo: **https://clinicstock.favourajayi308.workers.dev**
Synthetic data only. This is a demo, not a production clinical system (brief §8).

```bash
npm run build     # static export into out/, reads .env.local
npm run deploy    # wrangler deploy, config in wrangler.jsonc
```

## What is deployed, and what is not

The whole app is static files: HTML, JS and CSS from `out/`. Cloudflare runs
**no code** for us. There is no `main` script in `wrangler.jsonc` and no
bindings, so nothing on Cloudflare holds a secret. Every privileged action
happens in PostgreSQL (the four `SECURITY DEFINER` functions, behind RLS), which
the browser reaches directly with the user's own session.

## Why Workers, when the brief says Pages

Today `wrangler pages project create` announces that Pages is "now part of
Cloudflare Workers", delegates to Workers, and fails. `--force` still reaches
legacy Pages, but starting a new project on a path its vendor is retiring is debt
from day one. Workers *static assets* with no script is the same thing a Pages
static site was.

## Settings worth understanding (`wrangler.jsonc`)

| Setting | Why |
|---|---|
| `html_handling: auto-trailing-slash` | `/inventory` serves `inventory/index.html`; matches `trailingSlash: true` |
| `not_found_handling: 404-page` | An unknown URL gets a real 404, not the home page with 200. An SPA fallback makes typos look like working pages |
| wrangler pinned to `4.163.0` | Exact version, a week old at install. A deploy tool reads the Cloudflare token, and brand-new releases are where supply-chain compromises land |

## Configuration is baked in at build time

`NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` are
**inlined into the JavaScript** by `next build`. Setting them in the Cloudflare
dashboard would do nothing, because there is no server to read them. To change
them, rebuild and redeploy.

That is safe only because the key is *publishable*: it identifies the project,
and RLS decides what it may do. Audited before the first deploy:

- the URL and publishable key appear once in the bundle, as expected;
- the only `sb_secret_` / `service_role` strings are code (supabase-js's prefix
  check, and our own guard in `src/lib/supabase/client.ts` that refuses to
  start with a secret key), not key values;
- no source maps are shipped.

Repeat that audit whenever the env file changes. A secret key in a
`NEXT_PUBLIC_` variable would be published to every visitor, and no deletion
fully recalls it.

## Response headers (`public/_headers`)

`X-Frame-Options: DENY` plus `frame-ancestors 'none'` (no clickjacking),
`nosniff`, a strict referrer policy, and camera, mic and location disabled.

**Gap:** there is no full Content-Security-Policy. Next.js emits inline scripts,
so a strict CSP needs per-build hashes. Until then, an XSS bug would not be
contained by CSP.

## Supabase settings the deploy depends on (dashboard, not code)

Authentication → URL Configuration:

- **Site URL** must be the live URL above. `signUp` passes no
  `emailRedirectTo`, so confirmation emails link to the Site URL. Left at
  `localhost`, a clinic user's link opens nothing.
- **Redirect URLs**: add `https://clinicstock.favourajayi308.workers.dev/**`.

## Known issues

- The `workers.dev` subdomain is derived from the account's email name and is
  public in the URL. A custom domain, or renaming the account subdomain
  (Workers → Settings), removes it.
- A new `workers.dev` hostname published IPv6 records first, then an IPv4
  address ending in `.0`. From the development machine (WSL2: no IPv6 route,
  and a network path that drops the `.0` address), it timed out after a
  successful deploy. "Deployed" and "reachable" are separate facts. Check
  reachability from a browser or a phone on mobile data, not only from the dev
  machine.
- Anyone can sign up on the public URL and create a clinic. RLS confines them
  to their own clinic (`tests/db`), but email confirmation must be on before any
  pilot.
- Rollback: `npx wrangler rollback` restores the previous version, and
  `npx wrangler versions list` shows the history.
