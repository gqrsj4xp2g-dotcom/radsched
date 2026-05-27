# Environments

RadScheduler should be operated with separate Supabase projects and
separate deploy URLs for staging and production.

| Environment | Branch | Supabase project | Deploy purpose |
|---|---|---|---|
| Local | any | local/dev project | Developer validation and browser testing |
| Staging | `staging` | staging Supabase project | Full rehearsal with non-production data |
| Production | `main` | production Supabase project | Live practice scheduling |

## Promotion path

1. Land changes on a feature branch or local autosync branch.
2. Merge to `staging` and wait for **Staging Validation** to pass.
3. Run `npm run test:edge-monitor` against staging.
4. Apply SQL migrations to staging first.
5. Restore a production-like backup into staging and run the restore drill.
6. Merge to `main` only after staging passes.
7. Apply SQL migrations to production during a maintenance window.

## Required separation

- Use different Supabase project URLs and anon keys.
- Use different service-role secrets for edge functions.
- Never test backup restores against production unless the target is a
  deliberately copied/staging practice.
- Production deploys are from `main` only; staging validation runs on the
  `staging` branch and pull requests to `main`.
