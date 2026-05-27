# RBAC matrix

RadScheduler authorization is enforced in two places:

- Browser UX gates: `_isAdminOrSU()` and `_adminOnly(label)`.
- Supabase server gates: RLS policies and edge functions using
  `app_metadata.role`, `app_metadata.practiceId`, and JWT `aal`.

`user_metadata` is display-only and must never authorize privileged work.

| Capability | `superuser` | `admin` | `user` |
|---|---:|---:|---:|
| View own practice schedule | yes | yes | yes |
| Edit schedule data for own practice | yes | yes | yes, through permitted in-app workflows |
| Open Tools / Settings / user management | yes | yes | no |
| Create or edit users through `create-user` | yes | yes | no |
| Grant or modify `superuser` | yes | no | no |
| Switch between practices | yes | yes, when assigned | no |
| Restore backups through `admin-ops` | any practice | own practice only | no |
| Cross-practice RLS access | yes with `aal2` | yes with `aal2` | no |
| Run destructive admin operations | yes with `aal2` | yes with `aal2` | no |

## Enforcement checklist

- Privileged roles come from `app_metadata.role`.
- Tenant scope comes from `app_metadata.practiceId`.
- Admin/superuser privileged DB paths require `aal2` through
  `public.radscheduler_admin_aal2()`.
- Non-admin practice access is scoped with
  `public.radscheduler_non_admin_same_practice(target_practice_id)`.
- `create-user` requires `aal2` and blocks non-superusers from creating,
  granting, deleting, or editing `superuser` accounts.
- `admin-ops` requires `aal2`, writes restore audit evidence, and restricts
  admins to their own practice.
- E2E coverage includes the role matrix and admin MFA gate.

## Review cadence

Review this matrix quarterly, after adding a new role, or before any
customer-facing deployment that changes user management, practice switching,
backup restore, publishing, or bulk schedule mutation.
