# RadScheduler — Security model

> What's protected, what's not, and how to report a vulnerability.

## Reporting

Please email **mnboulous@gmail.com** with subject "RadScheduler
security" — please **do not** open a public GitHub issue. We
acknowledge within 48 hours and will publish a fix within a week
(usually faster) or coordinate disclosure.

## Threat model

RadScheduler is built for a single radiology practice with ≤50
physicians, ≤5 admin users, and a non-public deployment URL. It is
**not** built to defend against:

- Nation-state actors
- Determined insider attackers with shell access to your Supabase project
- Side-channel attacks against your browser

It **is** built to defend against:

- External attackers without credentials
- Casual snooping by physicians on each other's data
- Accidental data loss from concurrent edits or crashed tabs
- Common web vulnerabilities (XSS, CSRF, open-redirect, supply-chain)

## Authentication

- Supabase Auth (email + password). Magic links are also supported.
- Sessions are managed by the Supabase JS SDK using `localStorage`.
- Session refresh runs every 60 minutes; a re-login modal appears if
  the refresh fails.
- Sign-out clears `localStorage` and forces a page reload.

## Authorization

- **Roles** live in `app_metadata.role` on the Supabase user object.
  This is server-side and cannot be modified by the user. **Never**
  rely on `user_metadata` for security — it's user-writable.
- Three roles: `super_user`, `admin`, `physician`.
- Client-side checks (`_isAdminOrSU()`, `_adminOnly(label)`) are UX
  only. The source of truth is Row-Level Security (RLS) policies on
  the Supabase table.

### RLS policies (recommended set)

```sql
-- Read: any authenticated user in the practice
CREATE POLICY "Read practice rows" ON practices
  FOR SELECT TO authenticated
  USING (
    id = (auth.jwt() ->> 'app_metadata' ->> 'practice_id')::text
  );

-- Write: only admin / super_user
CREATE POLICY "Admin write" ON practices
  FOR UPDATE TO authenticated
  USING (
    (auth.jwt() ->> 'app_metadata' ->> 'role') IN ('admin','super_user')
    AND id = (auth.jwt() ->> 'app_metadata' ->> 'practice_id')::text
  );
```

Adapt to your schema. The point: **never trust the client** with
write authorization.

## Edge function security

Every request to `send-notification` requires
`Authorization: Bearer <Supabase JWT>`. The function calls
`supabase.auth.getUser(jwt)` and rejects 401 if the token is invalid
or expired. Without this, the function URL is a free SMS / email /
push relay for anyone who guesses it.

### Secrets

| Secret | Where | What if leaked |
|--------|-------|----------------|
| `SUPABASE_SERVICE_ROLE_KEY` | Edge function env | Full DB write — rotate immediately. |
| `RESEND_API_KEY` | Edge function env | Email send abuse — rotate. |
| `TWILIO_AUTH_TOKEN` | Edge function env | SMS abuse — rotate. |
| `VAPID_PRIVATE_KEY` | Edge function env | Push spoofing — rotate keys + re-subscribe users. |
| `SUPABASE_ANON_KEY` | Bundled in `index.html` | Designed to be public. RLS is what protects data. |

Never commit secrets to git. Use `supabase secrets set`.

### Rotation

If you suspect a leak:

1. Generate new credentials in the relevant provider (Resend, Twilio, etc.).
2. `supabase secrets set NEW_KEY=…`.
3. Re-deploy the edge function: `supabase functions deploy send-notification`.
4. Invalidate the old credentials in the provider console.

## XSS prevention

Every user-supplied string in HTML interpolation is wrapped in
`escHtml(…)`. This is enforced by code review — there is no static
analyzer, so reviewers must check.

We do **not** use `innerHTML = userText`. We do use templated
`innerHTML = `…${escHtml(userText)}…`` extensively.

Imported XLSX cells flow through `escHtml` before display. The Excel
parser does not execute formulas (SheetJS opt-in needed).

## CSP headers

Content Security Policy is set in:
- `_headers` (Netlify)
- `vercel.json` (Vercel)
- `.github/workflows/deploy.yml` if deploying via GitHub Pages

Recommended baseline:

```
Content-Security-Policy: default-src 'self';
  script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net https://*.supabase.co;
  style-src 'self' 'unsafe-inline';
  connect-src 'self' https://*.supabase.co wss://*.supabase.co https://maps.googleapis.com https://api.github.com;
  img-src 'self' data: https:;
  font-src 'self' data:;
  manifest-src 'self';
  worker-src 'self' blob:;
```

`'unsafe-inline'` is unfortunately required for the inline `<script>`
and `<style>` blocks. Future work would extract them to external
files with SRI hashes.

## CSRF

The app is a single-page client; the only state-changing endpoints
are Supabase REST + edge functions. Both require a Bearer token in
the `Authorization` header. Cookies are not used for auth. Therefore:

- No CSRF tokens needed for our origin's requests.
- Cross-site forged requests fail because they can't read our token
  from `localStorage`.

## Privacy

- Patient data is **not** stored. Only physician schedules.
- Physician PII (email, phone, name) lives only in your Supabase row.
- Audit log records who-did-what but not personal details beyond names.
- Push subscription tokens are stored in the practice row; deleting a
  physician removes their subscription from there but does not unregister
  the browser's push subscription. Documenting that for users.
- We do **not** send any telemetry to Anthropic / OpenAI / Google.
  All API calls go to your own Supabase project + the providers you
  configure.

## Browser permissions

The app may request:

| Permission | Why | When |
|------------|-----|------|
| Notifications | Push delivery | When a user opts in via Settings → Push |
| Persistent storage | Survive browser cleanup | Granted automatically on PWA install |
| Clipboard | Copy guest links / config exports | Lazy — when the user clicks "Copy" |

We do **not** request: location, camera, microphone, USB, MIDI, or any
sensor APIs. If a future feature does, document it here first.

## Known limitations

- The XLSX parser uses SheetJS via CDN. We pin a version (`0.18.5`)
  but a CDN-level compromise would inject code. Mitigation: SRI
  (Subresource Integrity) hashes — TODO.
- The audit log is per-tab in-memory plus persisted via the normal
  save path. A crashed tab loses unflushed entries.
- The undo ring is per-tab and not synced across tabs.
- Web Push tokens never expire; if a physician changes browsers,
  they need to re-opt-in. There's no automatic cleanup of stale tokens.

## Compliance

This app is **not HIPAA-certified out of the box**. Achieving HIPAA
compliance requires:

1. Supabase Pro plan + signed BAA.
2. End-to-end TLS (default with Supabase).
3. Audit log retention beyond 500 entries (currently capped at 500).
4. Documented breach-notification procedure.
5. Risk assessment + access reviews per your organization's policy.

Talk to your compliance officer before deploying anywhere PHI is
involved. The current schema does not include patient data, but
if your practice extends it to do so, the above applies.
