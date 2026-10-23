# Google sign-in — setup guide

"Continue with Google" is built into the existing authentication system (Better Auth 1.7.12, in `backend/`). It uses the OAuth 2.0 **authorization-code flow with PKCE and a signed `state`**, asks only for `openid email profile`, and never stores Google's tokens. Without credentials the button is simply not shown, and email/password sign-in is unaffected.

> **Secrets stay on the server.** The client ID and secret are read by the **backend** only (`AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET`). Never put them in frontend code, a `NEXT_PUBLIC_*` variable, a Git repository, a chat, or a screenshot. The browser is only ever sent to Google with a server-built URL that contains the (public) client ID.

## 0. Values you need first

| Item | Local development | Production |
|---|---|---|
| App origin (`APP_URL` in the backend) | `http://localhost:3000` | `https://<your real domain>` (the **frontend's** public origin; the frontend proxies `/api/*` to the private backend) |
| **Authorized redirect URI** (exact) | `http://localhost:3000/api/auth/callback/google` | `https://<your real domain>/api/auth/callback/google` |
| Authorized JavaScript origin | not required for this server-side flow (optional: `http://localhost:3000`) | not required (optional: `https://<your real domain>`) |

The redirect URI is always `APP_URL` + `/api/auth/callback/google`. Google compares it **exactly** (scheme, host, port, case, no trailing slash); a mismatch shows `redirect_uri_mismatch`. Production must be `https`; `http` is accepted by Google only for `localhost`. Wildcards and raw IP addresses are not allowed. Do not register a placeholder domain: register the domain you actually deploy to, and add each environment (e.g. staging) as a separate redirect URI.

## 1. Open Google Cloud Console
Go to <https://console.cloud.google.com/> and sign in with the Google account that should **own** the project (use an organisation or a dedicated account for production, not a personal one that may be lost).

## 2. Create or select a project
Project picker (top bar) → **New project** → name it (e.g. `studyforge-prod`; use a separate project, or at least a separate client, for local development) → **Create**, then select it. No API needs to be enabled: Google sign-in with `openid email profile` does not require enabling an API.

## 3. Configure the Google Auth Platform (OAuth consent screen)
Menu → **Google Auth Platform**. If it says "not configured yet", click **Get started**.

1. **App information** — App name (shown to users on the consent screen, e.g. `StudyForge AI`) and **User support email** → Next.
2. **Audience** — choose the user type:
   * **External** — anyone with a Google account (the normal choice for a public app).
   * **Internal** — only members of your Google Workspace organisation (use for a company-only deployment).
3. **Contact information** — an email Google can reach for project notices → Next.
4. Accept the *Google API Services: User Data Policy* → **Continue** → **Create**.

Then, in the left menu:

* **Branding** (optional but recommended): logo, app home page, privacy-policy and terms links (`https://<domain>/privacy`, `https://<domain>/terms` exist in the app), and **Authorized domains** (your production domain). Adding a logo or app name shown to all users can trigger *brand verification*; see §10.
* **Data Access** → **Add or remove scopes**: select **only** `openid`, `.../auth/userinfo.email` and `.../auth/userinfo.profile`. These are non-sensitive scopes. **Do not add** Gmail, Drive, Calendar or any other scope — the app does not need them and would then require Google's sensitive/restricted-scope review.

## 4. Audience and test users
Menu → **Google Auth Platform → Audience**.

* While **Publishing status = Testing** (External apps), only the accounts listed under **Test users → Add users** (maximum 100) can sign in. Add yourself and your testers.
* For apps that request **only** `openid`, `email` and `profile`, Google's documentation states that test users need not be on the list for consent purposes, do not see the unverified-app warning, and their authorisation does not expire after 7 days — but keep the list populated anyway while testing so behaviour matches what Google shows in your console.
* Switch to production in §10 with **Publish app**.

## 5. Create the OAuth 2.0 Web application client
Menu → **Google Auth Platform → Clients → Create client**.

1. **Application type: Web application**.
2. **Name**: e.g. `StudyForge local` / `StudyForge production` (one client per environment keeps secrets and redirect URIs separate).
3. **Authorized JavaScript origins** — leave empty (not used by the server-side code flow). If you add any, they must be origins only (scheme + host + port, no path), `https` except `localhost`.
4. **Authorized redirect URIs** → **Add URI** → paste the exact URI from §0 (add the local one to the local client, the production one to the production client).
5. **Create**.

## 6. Copy the client ID and secret into the server environment
Google shows the **client secret only once, at creation**; it cannot be viewed again. Copy it now (or download the JSON) into a password manager or your platform's secret store. If lost, add a new secret to the client from its details page, update the server, then disable the old one.

Set these in the **backend** environment (`backend/.env.local` for development — it is git-ignored; the host's secret manager in production):

```
APP_URL="http://localhost:3000"            # production: https://<your real domain>
BETTER_AUTH_SECRET="<>= 32 random chars>"  # already required: openssl rand -base64 48
AUTH_GOOGLE_ID="<client id>.apps.googleusercontent.com"
AUTH_GOOGLE_SECRET="<client secret>"
```

Rules: set **both or neither** (the backend refuses to start with half a configuration, without printing the values); do not set them in the frontend; do not commit them (`.env*` is ignored and CI runs a secret scan). `BETTER_AUTH_URL`/`AUTH_URL` are **not** used by this project — `APP_URL` is the canonical URL.

## 7. Test locally
1. Start the stack (`backend/scripts/dev-all.sh`, or run `rag_agent`, `backend`, `frontend` yourself) and open <http://localhost:3000/login>. **Use `localhost`, exactly as registered** (not `127.0.0.1`).
2. "Continue with Google" appears above the email form on `/login` and `/register`.
3. Click it → choose a Google account (a test user while in *Testing*) → you land on `/workspace` and see "Signed in with Google". A first-time sign-in creates the account.
4. Check: sign out and in again (same user, no duplicate); cancel at Google's screen (you return to the page with a neutral message); try an account whose email already has a password account (you are told to sign in with the password and connect Google in **Settings → Privacy & account → Sign-in methods**).
5. Troubleshooting: `redirect_uri_mismatch` → the URI in the Google client differs from `APP_URL` + `/api/auth/callback/google`; `access_denied` for a non-test user → add them under Audience → Test users; button missing → `AUTH_GOOGLE_ID`/`AUTH_GOOGLE_SECRET` not set in the **backend** process (check `GET /api/auth-providers` returns `{"google":true}`).

Automated tests need no Google credentials: the backend suite mocks Google's token endpoint (`backend/tests/helpers/google.ts`) and the browser suite intercepts the hop to `accounts.google.com`.

## 8. Configure production
1. In the **production** client add `https://<your real domain>/api/auth/callback/google` (and, optionally, the https origin).
2. Production backend environment: `NODE_ENV=production`, `APP_URL=https://<your real domain>` (must be https; start-up refuses otherwise), `BETTER_AUTH_SECRET`, `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET`. The backend stays private; only the frontend domain is public, and it forwards `/api/auth/*` to it.
3. Add the domain under **Branding → Authorized domains**, and make sure `/privacy` and `/terms` are reachable on it.
4. Deploy only after an explicit go-ahead; do not reuse the development client in production.

## 9. Request only what is needed
Scopes are fixed in code to `openid email profile` and the authorization request carries no `access_type=offline`, so Google issues no refresh token. Access, refresh and ID tokens are discarded before the account row is saved (verified by `backend/tests/integration/google-auth.test.ts`). The database keeps the provider (`google`) and Google's stable subject id (`sub`).

## 10. Verify the published application and consent-screen requirements
1. **Audience → Publish app** (Testing → In production) so any Google user can sign in. With only the three basic scopes there is no sensitive-scope review.
2. **Verification Center** (Google Auth Platform menu): resolve anything listed. Showing your own app name/logo on the consent screen may require **brand verification** (verified domain, public home page, privacy policy and terms matching the app). Until verified, users may see an "unverified app" screen, and Google caps unverified apps at 100 new users over the project's lifetime — complete verification before a public launch.
3. Confirm the final consent screen shows the right name, logo and links, and that only "See your primary Google Account email address / personal info / associate you with your personal info on Google" are requested.
4. Sign in from a fresh account that is **not** a test user to prove production access, then check the backend audit log (`auth.sign_up` / `auth.sign_in`).
5. Rotate the secret on any suspicion of exposure (add new secret → deploy → disable the old one). Rotating `BETTER_AUTH_SECRET` signs everyone out.

## Account rules (what users will experience)
* **New Google user** → account created (name, verified email, picture, provider `google`), no password; they can add one later via **Settings → Privacy & account** ("Email me a link to set one").
* **Returning Google user** → same account, matched on Google's stable id (not the email). Their app profile is never overwritten by Google data.
* **Unverified Google email** → refused; nothing is created.
* **Email already has an account** → Google is **never** attached automatically. The owner signs in with their password, then connects Google from Settings (requires a sign-in within the last 15 minutes and the same email address). Rationale: automatic email-based linking enables pre-registration account takeover; see DECISIONS D-043.
* A Google identity can belong to exactly one StudyForge user (database-enforced). The last remaining sign-in method cannot be removed.
