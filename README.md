# monocle-plugin-fastly

Monocle edge assessment and enforcement for [Fastly Compute](https://www.fastly.com/documentation/guides/compute/):
the Fastly adapter for [`@spur.us/monocle-edge-core`](https://github.com/spurintel/monocle-edge-core),
which owns the request pipeline, the `/__mcl/*` endpoints, decisions, credentials and injection.
This package supplies what the platform alone can: the stores, the backends, the origin leg, the
HTML rewrite, and the POP cache the breaker and crawler snapshot live in.

The plugin runs as a Compute service that fronts the customer's site. Assessed pages are served
with the resident script injected; enforced paths need a verdict cookie, minted by `/__mcl/verify`
after the Policy API evaluates an assessment; blocked verdicts get the block page.

## Request flow

```
Visitor ──▶ Compute service
              │  config, exclusions      ◀── Config Store (dashboard-written)
              │  secrets                 ◀── Secret Store
              │  breaker, crawler ranges ◀── POP cache (SimpleCache)
              ├─ /__mcl/*   verify ─▶ monocle_policy backend (Policy API)
              ├─ excluded path ─▶ origin backend, unassessed
              └─ pipeline   refuse | block | serve (+ inject) ─▶ origin backend
                                             └─ WebSocket upgrade ─▶ handed off to Fastly
```

## What the platform fixes

- **Every `fetch()` names a backend.** `origin` (the customer's site or chained service),
  `monocle_policy` (the Policy API) and one per crawler feed host (`crawler_developers_google_com`,
  `crawler_www_bing_com`), all static and created by the dashboard. No dynamic backends.
- **Nothing survives in memory between requests.** The deployment is compiled per request from
  the Config Store; the breaker state and the crawler snapshot live in the POP cache.
- **No scheduler.** Crawler ranges refresh lazily in `event.waitUntil` once the cached snapshot
  is an hour old, once per POP per lease. A snapshot is valid for a day, so it keeps exempting
  while the refresh lands; only a missing or expired one grants nothing.
- **Every attached domain is the site.** Fastly delivers only the domains attached to the
  service, and they all reach the same origin, so a hostname the deployment does not name is
  assessed and enforced like the ones it does.
- **The origin leg cannot carry a socket.** A WebSocket upgrade the pipeline lets through (an
  assessed path, or an enforced one with clearance) is handed to Fastly with
  `createWebsocketHandoff`. The service needs WebSocket passthrough enabled for that, a paid
  Fastly product the dashboard does not switch on; without it the upgrade fails.
- **No AES-GCM and no `AbortSignal`.** Cookies use edge-core's HMAC-SHA256 sealer; the Policy
  deadline is the `monocle_policy` backend's first-byte timeout.

## Config Store layout

Resource link `monocle_config`. Values are at most 8,000 characters, 500 items per store.

| Key | Value | Writer |
| --- | --- | --- |
| `v` | `2` | dashboard |
| `g` | generation the dashboard last wrote | dashboard |
| `id` | deployment id, the cookie audience | dashboard |
| `cv` | clearance version, 64 lowercase hex | dashboard |
| `x` | JSON array of exclusions: `/path`, `/path/*` or `/path*`; unreadable counts as a torn publish | dashboard |
| `cfgn`, `cfg.0` … `cfg.n-1` | the `DeploymentConfig` JSON (hosts, assess, allow IPs, injection, block page, session tracking, custom domain), in chunks | dashboard |
| `enfn`, `enf.0` … `enf.n-1` | enforcement as edge-core's route index, `{v:1, p:{exact paths}, s:{subtree roots}, w:[wildcard patterns]}`, in chunks | dashboard |
| `PUBLISHABLE_KEY` | Monocle publishable key | dashboard |
| `ORIGIN_HOST`, `CACHE_RULES`, `CHAIN_SECRET`, `CLIENT_IP_HEADER` | the origin leg: host override, cloned cache rules, chaining secret, an extra client-address header | dashboard |

Secret Store `monocle_secrets`: `SECRET_KEY` (Policy API) and `COOKIE_SECRET_VALUE` (64 hex, the
sealing key). A missing or torn config forwards requests to the origin unprotected with
`X-Monocle-Skip`; the origin leg still applies.

Enforcement is published as lookups rather than patterns because js-compute runs JavaScript
interpreted inside Wasm: compiling 5,000 enforce patterns per request measured 529 ms under
Viceroy, while the index costs a few milliseconds of `JSON.parse`.

## Develop

```bash
npm ci
npm run typecheck        # also checks edge-core's sources against js-compute's types
npm test                 # the handler in Node against the doubles in test/doubles
npm run build            # bundle + compile to bin/main.wasm
fastly compute serve     # Viceroy with [local_server]; plain HTTP is treated as HTTPS there
curl -H 'Host: example.com' -H 'Sec-Fetch-Mode: navigate' http://127.0.0.1:7676/members/page
```

edge-core is a private git dependency; CI loads a read-only deploy key from the
`MONOCLE_EDGE_CORE_SSH_KEY` secret.

## Release

Pushing a `v*` tag builds the Wasm package and publishes it as a GitHub Release asset (see
[`.github/workflows/release.yml`](.github/workflows/release.yml)), which the Spur web app deploys
through the Fastly API. The web app pins the version with `MONOCLE_FASTLY_PACKAGE_VERSION`; edge
contract 2 is `v2.*`.
