# Exposing GoTavern to the public internet: is a strong password enough?

Written 2026-10-27 against `main` = `18bcc07`. Every claim below cites either a GoTavern path:line or a pinned
SillyTavern path:line; nothing here is inferred from a document. This is a security review, not a change: no
runtime code, fixture, workflow or `AGENTS.md` rule was modified.

The question being answered is the user's, exactly: *"if I expose GoTavern to the public internet but set a
complex account password, is it safe?"*

---

## 1. Verdict

**A strong password is necessary and not sufficient.** It closes exactly one door — the login form — and leaves
every question about the wall around that door unanswered. In the default configuration a public deployment
survives on luck rather than on design, for one structural reason:

> **Upstream ships `whitelistMode: true` with a whitelist of only `::1` and `127.0.0.1`
> (`upstream/default/config.yaml:60,64-66`). That is a *loopback-only* server that is correctly closed to the
> internet.** The moment an operator opens it to the public — by adding their server's public IP, `*`, or a
> CIDR such as `0.0.0.0/0` — they have deliberately disabled the gate that was doing the work, and they must
> replace it with the account gate plus TLS. The password then becomes the only barrier, and several of the
> properties people assume come with "a strong password" do not hold.

**Public exposure with a strong password is acceptable under exactly these conditions**, all of which are
configurations the operator must set deliberately:

1. **`enableUserAccounts: true`** with a real password on **every** account — including any account that exists
   before they enable it. An empty-password account is auto-logged-in from the login page (F11), which is the most
   likely way a "I set a strong password" deployment is still wide open.
2. **TLS terminating at the process, or awareness that the session cookie will not be `Secure`** (see finding
   F3 — this is the one condition most likely to be missed).
3. **`forwardedHeaders` turned off, or only enabled when a trusted reverse proxy really sits in front** — because
   those headers are trusted by default and upstream's own config comment warns they "may lead to IP spoofing"
   (`upstream/default/config.yaml:203-204`).
4. **Whitelist mode disabled or made meaningful** — leaving `whitelistMode: true` while widening the whitelist to
   the internet gains nothing and only obscures what is actually protecting the server.
5. **Auto-update left off** (GoTavern's own product contract, `AGENTS.md` rule 26 — already the default here and
   already divergent from upstream in the safe direction).

If the operator does none of these and simply sets a password, the deployment is **not safe**, and the specific
reason is F1 and F2 below.

What a strong password *does* buy, and it is real: the login route is rate-limited, the password is stored behind
a memory-hard KDF, sessions are signed cookies with `httponly`/`samesite=lax`, and CSRF protection is on by
default. Section 5 lists those verified-sound items so the operator is not guessing about them.

---

## 2. Required configuration for a public deployment

| Key | Required value | Why |
|---|---|---|
| `enableUserAccounts` | `true` | The only gate that actually authenticates a person. Upstream default is `false` (`upstream/default/config.yaml:107`), and with it false every request is treated as the built-in `default-user` (`internal/server/http.go:534`). |
| every account's `password` | non-empty, unique, complex | An account with an empty password is auto-logged-in on the login page (`internal/server/accounts.go:369-371`) — a strong password on *your* account does not protect an account with none. |
| `whitelistMode` | `false` **once you are internet-facing** | With a public whitelist entry it no longer filters anything; with the shipped default it blocks you. Keep it `true` only if the deployment is loopback-only or sits behind a proxy that sets a trusted IP. |
| `whitelist` | `["127.0.0.1", "::1"]` **if** you keep whitelist mode and front it with a trusted proxy | The shipped default; do not add `*` or `0.0.0.0/0`. |
| `forwardedHeaders.xRealIp` | `false` | Default `true` (`internal/commandline/options.go:272`). The whitelist requires **both** the socket IP and this header's value to be whitelisted (`internal/server/whitelist.go:33-38`, pinned `src/middleware/whitelist.js:84-86`), so this alone does not open the whitelist — but it does mean an attacker who can reach the server controls a string that appears in logs and in the account-audit path (`internal/server/accounts.go:1359-1375`). Turn it off unless a trusted proxy sets it. |
| `forwardedHeaders.xForwardedFor` | `false` (same reasoning) | Default `true` (`internal/server/whitelist.go:69`), pinned `src/express-common.js:41`. |
| `enableForwardedWhitelist` | `false` | Upstream default `true` (`upstream/default/config.yaml:62`). It makes the whitelist *also* consult the forwarded header; with the header untrusted this only adds an attacker-controlled input. |
| `rateLimiting.preferRealIpHeader` | `false` (leave as shipped) | Pinned default `false` (`src/endpoints/users-public.js:11`), GoTavern default `false` (`internal/commandline/options.go:245`). Turning it **on** is what makes the rate limiter's key spoofable (finding F2) — do not enable it without a trusted proxy. |
| `disableCsrfProtection` | `false` (leave as shipped) | Already the default (`upstream/default/config.yaml:180`). Turning it on is a security regression you do not need. |
| `securityOverride` | `false` (leave as shipped) | Default `false` (`upstream/default/config.yaml:182`); it exists to bypass the listener security check, so leave it alone. |
| `sessionTimeout` | a positive number, e.g. `86400` | `-1` (the default, `upstream/default/config.yaml:178`) means a **400-day** cookie; see F5. |
| `enableDiscreetLogin` | `true` | Strongly recommended. Without it `POST /api/users/list` anonymously returns every enabled account's handle and a boolean saying whether it has a password — an attacker's shortlist. With it the route answers a bare `204` (F11). |
| `ssl.enabled` | `true` (with a cert), **or** a proxy on a private network | Default `false` (`upstream/default/config.yaml:50`). It is the only way the session cookie gets `Secure`; see F3. |
| `enableCorsProxy` | `false` (leave as shipped) | Default `false`. Not registered in GoTavern at all (see F7), so this is doubly moot here. |
| TLS | terminate at GoTavern, or accept that the cookie lacks `Secure` | See F3. |

---

## 3. Findings

Ordered by "does an attacker need credentials first?" — the unauthenticated ones come first, because they are the
ones a strong password does not touch.

### F1 — Whitelist bypass by header spoofing: **NOT exploitable**; the gate is an AND, not an OR

This was the highest-priority question and the answer is reassuring, so it is stated precisely rather than
dismissed.

GoTavern's whitelist (`internal/server/whitelist.go:23-40`) computes **two** values and requires **both** to
match:

```
clientIP    := requestClientIP(request)          // the TCP socket peer, :42-56
forwardedIP := realOrForwardedIP(request, ...)   // X-Real-IP / CF-Connecting-IP / X-Forwarded-For, :58-76
if !matchesAnyIP(whitelist, clientIP)                    { return false, ... }   // :33
if forwardedIP != "" && !matchesAnyIP(whitelist, forwardedIP) { return false, ... }   // :36
```

An attacker on the public internet who sends `X-Real-IP: 127.0.0.1` therefore has the socket IP tested against the
whitelist **first**, and their real public address fails it. The header cannot substitute for the socket address;
it can only *add* a requirement.

**Pinned behaves identically** — the same two-test AND in `src/middleware/whitelist.js:84-86`:

```js
if (!isIPInWhitelist(whitelist, clientIp)
    || (forwardedIp && !isIPInWhitelist(whitelist, forwardedIp))
)
```

Classification: **`inherited-pinned-behaviour`, severity none, no auth needed (moot).**

**Nothing strips or overrides a client-supplied `X-Real-IP`.** There is no trusted-proxy allowlist anywhere in the
chain: whatever the client sends is what `realOrForwardedIP` returns. That is pinned's design too. It is harmless
for the whitelist because of the AND, and it matters for F2 and F6.

**Does the whitelist still matter once accounts are on?** Yes, and it is the *stronger* of the two gates in one
specific sense: it runs **before** the account gate (`internal/server/http.go:501-507` vs `:554`, pinned
`src/server-main.js:145-148` before `:248`). Order in GoTavern: CORS → **basic auth** (`:498`) → **whitelist**
(`:501`) → host whitelist (`:508`) → session/account (`:517-557`). An IP outside the whitelist never reaches the
login form at all. But it is a *coarse* gate and cannot substitute for authentication: it admits everyone inside
the range, including an attacker on the same corporate network or behind the same NAT.

### F2 — The rate limiter's key is attacker-influencable: **inherited, low severity, needs no auth**

The login limiter is keyed by the string returned from `runtime.clientIP(request)`
(`internal/server/accounts.go:621-622`). That function returns `socketIP + " (forwarded: " + X-Real-IP)`
(`:1362-1363`) when `PreferRealIPHeader` is on. Because nothing upstream validates the header, an attacker who
sets `PreferRealIpHeader: true` **without** a trusted proxy lets each request choose its own limiter bucket simply
by changing the header — the limiter never accumulates.

**The shipped default makes this not-exploitable by accident:** `preferRealIpHeader` is `false` by default in
both implementations (GoTavern `internal/commandline/options.go:245`; pinned `src/endpoints/users-public.js:11`),
and with it `false` the key is the socket IP, which the attacker cannot forge. So this is a **misconfiguration
hazard**, not a live defect: it requires the operator to have set `preferRealIpHeader: true` while *not* actually
being behind the proxy that would make that correct.

**Pinned is identical** — `getIpAddress(request, PREFER_REAL_IP_HEADER)` with the same `socket (forwarded: x)`
composition (`src/express-common.js:70-74`, consumed at `src/endpoints/users-public.js:68`).

Classification: **`inherited-pinned-behaviour`, severity low, requires operator misconfiguration.**

Note the limiter is **IP-keyed, never account-keyed** in both implementations
(`internal/server/accounts.go:622`; pinned `src/endpoints/users-public.js:69`). So there is no per-account
lockout to complement it: an attacker rotating source IPs (say, a botnet) gets 5 attempts per IP per minute, and a
single-IP attacker gets exactly 5 per minute. See F4 for what that means for guessing.

### F3 — The session cookie is `Secure` only when TLS terminates at GoTavern: **govern difference, medium**

`internal/server/csrf_session.go:272-275`:

```go
attributes += "; samesite=lax; httponly"
if request.TLS != nil {
    attributes += "; secure"
}
```

`request.TLS` is the **only** condition. There is no `X-Forwarded-Proto` handling anywhere in the tree (verified:
no `ForwardedProto`/`IsSecureRequest` symbol exists). So:

- **TLS terminated by GoTavern itself** (its own `ssl` block, `upstream/default/config.yaml:47-57`): `request.TLS`
  is set, the cookie is `Secure`. Correct. **But `ssl.enabled` is `false` by default** (`:50`), so this is the
  *non-default* configuration.
- **TLS terminated by nginx/Caddy/a load balancer in front**: `request.TLS` is **nil**, and the cookie ships
  **without `Secure`**. The browser will still send it over HTTPS, but it will *also* send it over plain HTTP to
  the same host if any plain-HTTP request ever happens — which is exactly the case `Secure` exists to prevent.

**Pinned is worse here, not better, and this is a Govern improvement:** pinned sets `sameSite: 'lax'` and
`httpOnly: true` and **no `secure` flag at all** (`src/server-main.js:156-162`). GoTavern adds `Secure` whenever
it can detect TLS. Neither implementation is proxy-aware.

Classification: **`govern-difference`(improvement over pinned), severity medium — and it is a required
configuration item, not only a proxy concern.** Because `ssl.enabled` ships `false`
(`upstream/default/config.yaml:50`), an operator who puts GoTavern behind a reverse proxy AND leaves `ssl` off —
the most common public deployment — gets a session cookie that is **not** `Secure` in either implementation. The
only way to get the flag is to terminate TLS in GoTavern itself (or to accept its absence knowingly). Put the
proxy on a private network such that plain HTTP cannot reach the client, or better, enable `ssl`.

Related and worth stating plainly: **over plain HTTP the password travels in the clear** in the login POST body.
Neither implementation can prevent that. There is **no redirect-to-HTTPS** and **no HSTS enforcement path** for
the plain-HTTP case — GoTavern does set `Strict-Transport-Security` on every response
(`internal/server/http.go:570`), but HSTS is ignored by browsers when received over plain HTTP, so it cannot
rescue a misconfigured deployment; it only helps *after* a successful HTTPS visit. There is no documented
requirement that the listener be TLS in `docs/INSTALLATION.md` beyond the `ssl` config block being optional.

### F4 — Brute force: the limits are real but small, and "complex password" carries the whole load

Effective defaults when `rateLimiting:` is at upstream's values (`upstream/default/config.yaml:191-202`):

| limiter | points | window | source |
|---|---|---|---|
| account login | 5 | 60 s | pinned `src/endpoints/users-public.js:19-22` (`LOGIN_POINTS` = 5 at `:12`); GoTavern `internal/server/accounts.go:117,153` |
| account recovery | 5 | 300 s | pinned `:23-26`; GoTavern `:124,154` |
| account reset | 5 | 300 s | pinned `src/endpoints/users-private.js:22`; GoTavern `:131,155` |
| basic auth | 5 | 60 s | pinned `src/middleware/basicAuth.js:16-21` |

**What happens on exhaustion:** HTTP 429 with `Retry-After`, and the attempt is *rejected before the password is
compared* (`internal/server/accounts.go:623-628`; pinned throws the limiter result at `src/endpoints/users-public.js:69`).
It is a **delay**, not a lockout — nothing is disabled, nothing alerts, and the window simply rolls.

Arithmetic for the user's actual question, stated because "impractical" should be a number: 5 attempts/minute
= 300/hour = 7,200/day per source IP. Against a 12-character random alphanumeric password (~71 bits) that is
7,200 / 2^71 per day — nothing. Against a *memorable* password that an attacker can find in a wordlist, the
limiter is irrelevant; the password is the whole control. **The limiter makes online guessing impractical only if
the password was not guessable in the first place.** And since the key is IP-only (F2), an attacker with many
source addresses multiplies the 7,200/day.

Classification: **`inherited-pinned-behaviour`, severity informational** — but the dependency is the point of this
document: it is the reason a *weak* password is fatal and a strong one is adequate.

### F5 — Session lifetime: 400 days, but revocable by a password change: **inherited, medium**

`sessionTimeout: -1` (the default, `upstream/default/config.yaml:178`) is not "the session ends when the browser
closes". It resolves to **400 days** — the RFC 6265 maximum — in both implementations
(GoTavern `internal/server/csrf_session.go:288-290`; pinned `src/users.js:619-628`).

Consequence: a stolen cookie is a 400-day credential, and it is `httponly` but not bound to the client IP.

**It can be revoked**, which is the good news and is worth knowing: the session stores a `version` derived from
the account's `handle`, `password` and `salt` (`internal/server/accounts.go:273-284`), and `currentUser` compares
the stored version against the account's current one, returning `invalidated` when they differ
(`:343-348`; the middleware then clears the cookie, `internal/server/http.go:525-528`). So **changing the account
password invalidates every existing session for that account.** Disabling the account also locks it out
(`internal/server/accounts.go:340`). There is no per-session "log out all devices" control beyond that.

Operator action: set a positive `sessionTimeout` (e.g. `86400`) for a public deployment.

### F6 — Auth enforcement coverage: the exemption list is small and contains no user-data route

The account gate is one check for the whole mux (`internal/server/http.go:554`); every route is registered on that
mux (`:304-491`), so the exemption list **is** the complete answer. It is
`internal/server/accounts.go:419-441`:

| Exempt | Method | Why it is acceptable |
|---|---|---|
| `/`, `/login`, `/csrf-token` | GET | The login page and its CSRF token; `/` redirects to `/login` when anonymous (`internal/server/static.go:153-159`). |
| `/callback`, `/callback/*` | GET | OAuth redirect target (`internal/server/http.go:483-484`); serves a fixed page. |
| `/api/users/list`, `/api/users/login`, `/api/users/recover-step1`, `/api/users/recover-step2` | POST | Login and recovery, open by construction. `/api/users/list` returns `204` when `enableDiscreetLogin` is set (`internal/server/accounts.go:469-473`); otherwise it discloses the enabled accounts' **handle, display name, creation timestamp, avatar URL, and a `password` boolean** (`:493-503`, `publicUser` at `:49-55`). No secret is disclosed, but it is an account enumeration and a "which account has no password" oracle — see F11. |
| a data-root `user.css` override | GET | Pinned mounts `userCssMiddleware` before `requireLoginMiddleware` so an anonymous browser can style the login page. GoTavern serves exactly one global file, `<dataRoot>/_css/user.css` (`internal/server/frontend_assets.go:141-151`, `:157-164`) — a fixed path with no request input, CSS content only. |
| embedded/pinned frontend statics | GET | Resolved from `installRoot/public/**` or the embedded FS only, with an explicit `..`/absolute/backslash reject (`internal/server/static.go:127-134`) and **no data-root fallback** for this path (`:227-259`). Frontend assets, not user files. |

**One nuance worth recording, because it looks like a hole and is not.** The user-data static mounts
(`/backgrounds/*`, `/user/images/*`, `/user/files/*`, `/characters/*`, …) call `serveUserDataStatic`, which first
tries the *pinned frontend* resolution (`internal/server/frontend_assets.go:119-122`) — so a request that matches an
embedded `public/` asset is answered anonymously — and only past that point requires an account
(`:123-126`, `settingsRequestAccount`). In other words the anonymous path serves **frontend assets that also exist
in the embedded tree**, and the user's files are behind the account check. That ordering is pinned's, because
`express.static(public)` is mounted (`src/server-main.js:242`) before `requireLoginMiddleware` (`:248`).

**Notable and worth confirming for the user: `GET /version` is NOT public.** It is not in the exemption list, so
with accounts enabled an anonymous request gets `403 Forbidden` — and that is exactly what pinned does
(`/version` is registered *after* `requireLoginMiddleware`, `src/server-main.js:248` then `:272`), and it matches
the recorded oracle `tests/oracle/sillytavern-1.19.0-account-session.json:66-71` (`"status": 403, "body":
"Forbidden"`). So the route that advertises the product version is deliberate parity, not a leak, and it exposes
only static build identity (`internal/server/http.go:660-679`) when reached authenticated.

**The user-data routes the question asked about are all behind the gate**: `/proxy/` does not exist (F7), the
extension trees are served statically but the *install/update* calls are POSTs on the mux, and every
`/api/**` user-data route (characters, chats, worldinfo, presets, secrets, settings, images, files, sprites) is
registered on the same mux and therefore gated.

Classification: **`inherited-pinned-behaviour`, no finding.** I found **no unauthenticated route that reads or
writes user data.** This was the single most important thing to establish and it holds.

### F7 — SSRF: `/proxy/` is not implemented here, so the classic vector is absent

Pinned registers `app.use('/proxy/:url(*)', corsProxyMiddleware)` and it is **gated by `requireLoginMiddleware`**
because it registers after it (`src/server-main.js:248`, `:257-265`), and it is disabled unless
`enableCorsProxy` is set (`upstream/default/config.yaml:76`, default `false`).

**GoTavern registers no `/proxy` handler at all** — `git grep 'HandleFunc(".*proxy'` over `internal/` returns
nothing, and `internal/server/csrf_session.go:191` only *names* the path for a CSRF exemption when
`EnableCorsProxy` is set. So the CORS-proxy SSRF vector does not exist in this implementation. When it is
implemented it will need to reproduce pinned's behaviour, which does **not** block cloud metadata
(`169.254.169.254`), loopback, or RFC1918 — pinned forwards whatever URL it is given. That is a
**future** finding, not a current one, and it is worth recording so the implementer sees it before shipping the
route.

**For an authenticated user**, provider calls and content import do fetch arbitrary URLs — that is the product's
job. Content import validates the host against `whitelistImportDomains` for the generic branch
(`internal/server/content.go:12,233`) and reproduces pinned's substring-matching weakness on provider branches
(recorded as an inherited property in `AGENTS.md` "Architecture boundaries" §5). Provider URL overrides
(`GOTAVERN_*_URL`) are process-environment settings, not user-settable, so they are not an SSRF path.

**No SSRF is reachable without authentication.** Classification: **`govern-difference`(route absent),
severity none today.**

### F8 — Authenticated user → server-side code execution: **not possible**, because no JS runs on the server

Extension install writes files and runs `git`; it does **not** execute extension JavaScript on the server. GoTavern
has **no JavaScript engine** — there is no `goja`/`otto`/`v8`/`quickjs` dependency in `go.mod` — and extension
files are served statically for execution in the *victim's browser*
(`internal/server/extensions_static.go`). So an authenticated attacker who installs an extension gains
**stored-XSS-in-their-own-browser**, and potentially in *other* users' browsers if the extension is `global` —
which requires admin in both implementations (`internal/server/extensions_git.go:640` vs pinned
`src/endpoints/extensions.js:96`).

That is still a real privilege boundary worth naming: **a non-admin authenticated user can install a private
extension, and an admin can install a global one that runs in every user's browser.** Pinned behaves identically
(`extensions.js:96-99` checks admin only for `global`). Classification: **`inherited-pinned-behaviour`, severity
medium, requires auth first.** Mitigation is operational: one account, admin, no untrusted users.

### F9 — File upload / serving path traversal: **not found**

Preset/file names pass `SanitizeUserFilename` → `sanitizeUserPresetFilename`
(`internal/startup/user_presets.go:139-157`), which **drops** `/`, `?`, `<`, `>`, `\`, `:`, `*`, `|`, `"` and
control characters (`:159-163`), rejects dot-only and Windows-reserved names (`:149-154`), and truncates to 255
bytes. A `../` or `..\` component cannot survive that. Static serving independently rejects `..`, absolute paths
and backslashes (`internal/server/static.go:127-134`). Uploads land in the data root, not the install tree.

This matches pinned's sanitizer behaviour. Classification: **no finding.** (This is a name-level check, not an
exhaustive audit of every route that joins a path — see §6.)

### F10 — Basic-auth password comparison is not constant-time: **inherited, informational**

`basicAuthCredentialMatches` compares the configured username and password with Go's `==`
(`internal/server/basic_auth.go:124`), and pinned does the same with `===`
(`src/middleware/basicAuth.js:59`). This is a **timing side channel in principle only**: both values are compared
after a network round trip, over which the nanoseconds-scale difference is not recoverable in practice, and the
rate limiter is checked first. Account passwords do **not** use this path — they use
`upstreamPasswordHash` + `subtle.ConstantTimeCompare` (`internal/server/accounts.go:644-648`).

Classification: **`inherited-pinned-behaviour`, severity informational.** Noted for completeness, not a defect to
act on.

### F11 — Unauthenticated account enumeration: **inherited, low severity, needs no auth**

`POST /api/users/list` is in the public exemption list, so an anonymous client can ask it who exists. It returns
each **enabled** account's `handle`, `name`, `created`, `avatar` URL, and a boolean `password`
(`internal/server/accounts.go:493-503`, struct `:49-55`).

**Pinned returns exactly the same object**, field for field, including `password: !!user.password`
(`src/endpoints/users-public.js:42-48`). So this is parity, not a regression.

Why it matters for *this* question specifically: the `password` boolean tells an attacker **which account has no
password set**. That is the single most valuable bit an attacker can have against a deployment where the operator
believes "I set a complex password" — because a strong password on the admin account is worth nothing if a second
account exists with an empty one, and this route points right at it. That empty account is auto-logged-in from the
login page (`internal/server/accounts.go:369-371`).

Operator action: `enableDiscreetLogin: true`, which turns the route into a bare `204` in both implementations
(`internal/server/accounts.go:470-472`; pinned `src/endpoints/users-public.js:30-32`). **This is the one
setting I would call strongly recommended for any public deployment, and it is not in most people's mental model
of "set a strong password".**

Classification: **`inherited-pinned-behaviour`, severity low (information disclosure), needs no auth.**

---

## 4. Ranked summary

| Rank | Finding | Class | Severity | Needs auth? |
|---|---|---|---|---|
| 1 | F3 session cookie is never `Secure` on a default deployment (`ssl.enabled: false`) | `govern-difference` (still better than pinned, which sets none) | medium | no (affects every session) |
| 2 | F8 non-admin can install a private extension → runs in other browsers only if global (admin); no server-side execution | `inherited-pinned-behaviour` | medium | **yes** |
| 3 | F5 400-day sessions on default `sessionTimeout: -1` | `inherited-pinned-behaviour` | medium | no (impact after theft) |
| 4 | F11 `POST /api/users/list` enumerates accounts **and reveals which have no password** | `inherited-pinned-behaviour` | low | **no** |
| 5 | F2 rate-limiter key spoofable **if** `preferRealIpHeader: true` is set without a trusted proxy | `inherited-pinned-behaviour` | low | no |
| 6 | F4 only 5 attempts/min/IP, no account lockout | `inherited-pinned-behaviour` | informational | no |
| 7 | F10 non-constant-time basic-auth compare | `inherited-pinned-behaviour` | informational | no |
| — | F1 whitelist header spoofing | `inherited` — **not exploitable** (AND gate) | none | — |
| — | F6 unauthenticated routes | `inherited` — exemption list contains **no user-data route** | none | — |
| — | F7 `/proxy/` SSRF | `govern-difference` — route **not implemented** | none today | — |
| — | F9 upload/serving traversal | none found | — | — |

No finding rises to "do not publish". The top unauthenticated item (F3) is a configuration consequence of
terminating TLS in a proxy, not a defect in GoTavern, and GoTavern is strictly better than pinned on it.

---

## 5. What is NOT a problem (verified, so you are not guessing)

These were checked and are sound. Stating them prevents a reader from assuming the worst about surfaces that are
fine.

- **Password hashing.** Accounts use scrypt and SHAKE-256 (`golang.org/x/crypto/scrypt`, `sha3.NewShake256()` in
  `internal/server/accounts.go`), compared with `subtle.ConstantTimeCompare` (`:648`). Memory-hard, salted,
  constant-time. A strong password is stored well.
- **CSRF is on by default** (`disableCsrfProtection: false`, `upstream/default/config.yaml:180`) and enforced
  before the route for state-changing requests (`internal/server/http.go:546-553`), with a per-session token
  compared before dispatch.
- **Cookie flags.** `samesite=lax; httponly` always, plus `secure` when TLS is detected
  (`internal/server/csrf_session.go:272-275`) — better than pinned, which sets no `secure` at all
  (`src/server-main.js:156-162`).
- **Security headers** are set on every response and match pinned via helmet: COOP, CORP, `no-referrer`, HSTS,
  `nosniff`, `X-Frame-Options: SAMEORIGIN`, and others (`internal/server/http.go:565-578`).
- **Whitelist is an AND, not an OR** — the header cannot substitute for the socket IP (F1).
- **`/version` is login-gated** and returns only static build identity, exactly as pinned does and as the recorded
  oracle shows (F6).
- **The `/proxy/` SSRF route does not exist** in this build (F7).
- **No server-side JavaScript execution**, so extension install is not RCE on the server (F8).
- **File-name sanitisation blocks traversal** at the name level (F9).
- **Auth gate covers every route** — one check for the whole mux, with a small explicit exemption list (F6).
- **Sessions are revocable** by a password change or by disabling the account (F5).
- **Auto-update defaults to OFF** for every ambiguous input, a deliberate divergence from upstream recorded as
  `AGENTS.md` rule 26 — the opposite of the usual "internet-exposed daemon quietly pulls code" problem.

---

## 6. What I could NOT determine

Stated plainly so this document is not read as broader than it is.

1. **No dynamic testing.** This host runs no Go toolchain, no browser and no probes; every conclusion is from
   source. I did not execute the server, so a finding could exist behind a code path I read as unreachable. The
   strongest mitigation is that each claim is anchored to a specific line rather than to a description.
2. **Path-join safety is audited by name, not exhaustively.** F9 establishes that *filenames* cannot carry
   traversal. I did not enumerate every route that composes a filesystem path from request input (avatars, images,
   files, assets, sprites, backgrounds, extension static), so I cannot claim exhaustive coverage of that class.
   Pinned's own behaviour in each is the comparison that would settle it.
3. **TLS configuration itself is unverified.** I read that `ssl` exists in the default config
   (`upstream/default/config.yaml:44-57`) and that `request.TLS` drives the cookie flag, but I did not verify the
   certificate-loading path, minimum TLS version, or cipher selection.
4. **No dependency/CVE review.** I did not audit `go.mod` or the pinned `package-lock.json` for known
   vulnerabilities.
5. **Pinned's own hardening posture beyond the cited files** (e.g. express/helmet versions) was not reviewed.
6. **The `/proxy/` route's future implementation** must reproduce pinned's unfiltered forwarding unless a
   deliberate, recorded decision changes it — noted in F7, not decidable today.
