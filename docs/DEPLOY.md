# Deploy

Three things to set up: Supabase (the database), the host (where
`index.html` lives), and one bootstrap admin so somebody can sign in
with privileges.

---

## 1. Supabase

### Create the project

[supabase.com](https://supabase.com) → **New project**. Pick the closest
region. Save the project URL and the **anon (public) key**.

Before inviting real users, open **Authentication → Security** and enable
leaked-password protection. This dashboard setting is not exposed to the
public browser client, so treat it as a required manual go-live check.

### Run the SQL

Open **SQL Editor** → **New query**, paste, run:

```sql
-- ── Practices: each row is a tenant ─────────────────────────────────────
CREATE TABLE practices (
  id   TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE practices ENABLE ROW LEVEL SECURITY;

CREATE POLICY "practices_select" ON practices FOR SELECT
  TO authenticated
  USING (
    (((select auth.jwt()) -> 'app_metadata' ->> 'role') IN ('admin','superuser')) OR
    (id = ((select auth.jwt()) -> 'app_metadata' ->> 'practiceId'))
  );

CREATE POLICY "practices_insert" ON practices FOR INSERT
  TO authenticated
  WITH CHECK (((select auth.jwt()) -> 'app_metadata' ->> 'role') IN ('admin','superuser'));

CREATE POLICY "practices_update" ON practices FOR UPDATE
  TO authenticated
  USING (((select auth.jwt()) -> 'app_metadata' ->> 'role') IN ('admin','superuser'))
  WITH CHECK (((select auth.jwt()) -> 'app_metadata' ->> 'role') IN ('admin','superuser'));

-- ── radscheduler: the main per-practice payload ─────────────────────────
CREATE TABLE radscheduler (
  id          TEXT PRIMARY KEY REFERENCES practices(id) ON DELETE CASCADE,
  data        TEXT NOT NULL,
  practice_id TEXT GENERATED ALWAYS AS (id) STORED,
  updated_at  TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE radscheduler ENABLE ROW LEVEL SECURITY;

CREATE POLICY "radsched_select" ON radscheduler FOR SELECT
  USING (
    (((select auth.jwt()) -> 'app_metadata' ->> 'role') IN ('admin','superuser')) OR
    (((select auth.jwt()) -> 'app_metadata' ->> 'practiceId') = id)
  );

CREATE POLICY "radsched_insert" ON radscheduler FOR INSERT
  WITH CHECK (
    (((select auth.jwt()) -> 'app_metadata' ->> 'role') IN ('admin','superuser')) OR
    (((select auth.jwt()) -> 'app_metadata' ->> 'practiceId') = id)
  );

CREATE POLICY "radsched_update" ON radscheduler FOR UPDATE
  USING (
    (((select auth.jwt()) -> 'app_metadata' ->> 'role') IN ('admin','superuser')) OR
    (((select auth.jwt()) -> 'app_metadata' ->> 'practiceId') = id)
  )
  WITH CHECK (
    (((select auth.jwt()) -> 'app_metadata' ->> 'role') IN ('admin','superuser')) OR
    (((select auth.jwt()) -> 'app_metadata' ->> 'practiceId') = id)
  );

-- ── radscheduler_backups: dedicated table for daily snapshots ──────────
-- Separate table so backup IDs (`<practice>_backup_YYYY-MM-DD`) don't
-- conflict with the FK constraint on the main radscheduler table.
CREATE TABLE radscheduler_backups (
  id          TEXT PRIMARY KEY,
  practice_id TEXT NOT NULL,
  data        TEXT NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE radscheduler_backups ENABLE ROW LEVEL SECURITY;

CREATE POLICY "backups_select" ON radscheduler_backups FOR SELECT
  USING (
    (((select auth.jwt()) -> 'app_metadata' ->> 'role') IN ('admin','superuser')) OR
    (((select auth.jwt()) -> 'app_metadata' ->> 'practiceId') = practice_id)
  );

CREATE POLICY "backups_insert" ON radscheduler_backups FOR INSERT
  WITH CHECK (
    (((select auth.jwt()) -> 'app_metadata' ->> 'role') IN ('admin','superuser')) OR
    (((select auth.jwt()) -> 'app_metadata' ->> 'practiceId') = practice_id)
  );

CREATE POLICY "backups_update" ON radscheduler_backups FOR UPDATE
  USING (
    (((select auth.jwt()) -> 'app_metadata' ->> 'role') IN ('admin','superuser')) OR
    (((select auth.jwt()) -> 'app_metadata' ->> 'practiceId') = practice_id)
  )
  WITH CHECK (
    (((select auth.jwt()) -> 'app_metadata' ->> 'role') IN ('admin','superuser')) OR
    (((select auth.jwt()) -> 'app_metadata' ->> 'practiceId') = practice_id)
  );

CREATE POLICY "backups_delete" ON radscheduler_backups FOR DELETE
  USING (
    (((select auth.jwt()) -> 'app_metadata' ->> 'role') IN ('admin','superuser')) OR
    (((select auth.jwt()) -> 'app_metadata' ->> 'practiceId') = practice_id)
  );

-- Seed: the default 'main' practice row so the app has somewhere to land
-- before the first admin creates additional practices.
INSERT INTO practices (id, name) VALUES ('main', 'Radiology Practice')
ON CONFLICT (id) DO NOTHING;

INSERT INTO radscheduler (id, data) VALUES ('main', '{}')
ON CONFLICT (id) DO NOTHING;
```

### Deploy the edge functions

Core edge functions are required for admin operations the client can't do
directly (writing to `app_metadata`, destructive restores, and other
service-role actions require server-side enforcement):

#### `create-user`

Creates a new auth user, sets `app_metadata.role` and `practiceId`,
returns the new user's ID. The client UI invokes this from
**User Management → Add User**. The function verifies the caller's
`app_metadata.role` and requires an `aal2` MFA session.

```bash
supabase functions deploy create-user --no-verify-jwt
```

#### `admin-ops`

Runs destructive administrator actions with the service role key. Today it
handles backup restores by validating the backup payload, writing the active
practice row, and recording audit + telemetry evidence. The function verifies
the caller's `app_metadata.role`, requires `aal2`, and blocks admins from
restoring another practice unless they are superusers.

```bash
supabase functions deploy admin-ops --no-verify-jwt
```

The function source lives in **Settings → Edge Functions → Function source
preview** inside the app.

#### `send-notification` (optional)

If you want email notifications (chat mentions, swap responses, holiday
assignments), wire `send-notification` to a transactional provider like
Resend. Without it, the in-app notifications still work — just no email.

```bash
supabase functions deploy send-notification --no-verify-jwt
supabase secrets set RESEND_API_KEY=re_xxx
supabase secrets set RESEND_FROM_EMAIL='RadScheduler <noreply@your-domain>'
supabase secrets set RS_CRON_SECRET='generate-a-long-random-string'
```

The function performs its own auth checks. Regular notification requests
still require a signed-in user's JWT; the `RS_CRON_SECRET` path exists
only for scheduled digest fanout.

### First admin

Sign up via the auth screen with whatever email you want as your admin
account. Then in the Supabase dashboard:

```sql
UPDATE auth.users
   SET raw_app_meta_data = raw_app_meta_data || '{"role":"admin","practiceId":"main"}'::jsonb
 WHERE email = 'your.email@example.com';
```

Sign out and back in — the new JWT will have the admin claim and you'll
see the full admin UI.

Before production use, run the launch checklist in [GO-LIVE.md](GO-LIVE.md).

---

## 2. Hosting

### GitHub Pages (cheapest, recommended)

1. Push this repo to GitHub.
2. **Settings → Pages → Source → GitHub Actions**.
3. The included `.github/workflows/deploy.yml` validates the inline JS
   parses, then deploys on every push to `main`. The first deploy may
   take a minute; subsequent ones are seconds.
4. The site will be at `https://<user>.github.io/<repo>/`. To use a
   custom domain (e.g. `radsched.org`), add a `CNAME` file at the repo
   root containing the domain, and configure DNS:

   ```
   A    @     185.199.108.153
   A    @     185.199.109.153
   A    @     185.199.110.153
   A    @     185.199.111.153
   CNAME www  <user>.github.io
   ```

### Vercel

1. Connect the repo. Vercel auto-detects there's no build step.
2. The included `vercel.json` configures cache headers, security
   headers, and a SPA-style rewrite to `index.html`.
3. Custom domain: **Settings → Domains → Add**.

### Netlify

Same shape as Vercel; the included `_headers` file handles cache and
security. Netlify's `netlify.toml` is not needed for this project.

### Self-host

Copy `index.html`, `sw.js`, `manifest.webmanifest`, `404.html`, and
the `icons/` directory to any static host. Apply the same headers as
`_headers` if you want strict caching + security defaults.

---

## 3. Autopush from local disk to GitHub <a id="autopush"></a>

Optional. If you prefer to edit `index.html` locally and have changes
pushed to your repo automatically:

```bash
brew install fswatch
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.radscheduler.autopush.plist
```

Logs go to `~/Library/Logs/rs-autopush.{log,err}`. The script's
single-instance lock is PID-file based (macOS doesn't ship `flock`).

---

## 4. Service worker

The service worker (`sw.js`) is included at the repo root. On first
visit after deploy, the browser registers it automatically and the
shell becomes available offline. The Settings → Offline support card
shows current registration state and lets admins force-unregister or
re-check.

Service workers require **HTTPS** (or localhost). They are silently
disabled when the page is loaded from `file://`.

---

## Operational notes

- **Save indicator** in the toolbar shows sync state. `✓ Synced` after a
  successful push, `⏳ Saving…` during, `⚠ Sync failing` after several
  consecutive errors.
- **Stale-save badge** appears red if nothing has synced in 5 minutes —
  clicking it forces a retry.
- **Backups** run automatically once per day. Browse and restore from
  Settings → Backups & Restore.
- **Cmd/Ctrl+S** forces an immediate save anywhere in the app.
- **Cmd/Ctrl+Z** / **Cmd/Ctrl+Shift+Z** are global undo/redo.
- **ESC** closes the mobile drawer or any open modal.
