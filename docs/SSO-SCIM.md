# SSO and SCIM readiness

RadScheduler is ready to use Supabase Auth SAML SSO once the Supabase
project is on a plan that supports project SSO and an identity provider
metadata URL/file is available.

Current official Supabase references:

- Project SAML SSO:
  <https://supabase.com/docs/guides/auth/enterprise-sso/auth-sso-saml>
- Password security and leaked-password protection:
  <https://supabase.com/docs/guides/auth/password-security>

## SAML SSO implementation path

1. Upgrade the Supabase project if needed.
2. Collect the IdP metadata URL or XML file from Okta, Entra ID, Google
   Workspace, Auth0, Ping, or another SAML 2.0 provider.
3. Register the provider:

   ```bash
   supabase sso add --type saml --project-ref <project-ref> \
     --metadata-url 'https://idp.example.com/metadata' \
     --domains example.org
   ```

4. Configure attribute mapping so the IdP supplies email, first name,
   last name, role, and practice id where available.
5. In RadScheduler, configure the SSO email domain on the login screen or
   Settings -> Supabase.
6. Keep `create-user` available as a break-glass admin path until the IdP
   provisioning workflow has been proven in staging.

## SCIM provisioning stance

Supabase Auth does not expose a first-party SCIM provisioning workflow in
the current public Auth docs. Enterprise provisioning should therefore be
implemented through one of these patterns:

- IdP-driven lifecycle into Supabase Auth using a trusted automation that
  calls the Supabase Admin API and writes `app_metadata.role` /
  `app_metadata.practiceId`.
- A third-party identity layer such as Auth0 or WorkOS, then Supabase
  third-party Auth JWT verification.
- A scheduled deprovisioning report until full SCIM automation exists.

## Deprovisioning controls

- Departed staff must be disabled in the IdP and Supabase Auth.
- Remove the user from RadScheduler user management.
- Rotate any shared notification/webhook secrets if the departing user had
  access to them.
- Export the audit log entry for the removal.

## Staging acceptance test

- SSO user can sign in from the configured domain.
- JWT contains the expected identity and `app_metadata` claims.
- `user` role cannot open Tools.
- `admin`/`superuser` role cannot open privileged paths until `aal2`.
- Deprovisioned user fails login and loses active sessions.
