# Security policy

## Reporting a vulnerability

Report privately through GitHub's [Report a vulnerability](https://github.com/tuckerwales/nslibrary/security/advisories/new)
form. Please do not open a public issue for anything exploitable.

Include what you can: version or commit, how you reached the server (LAN, USB, reverse proxy), and
the smallest sequence of steps that reproduces it. A proof of concept helps but is not required.

This is a hobby project maintained by volunteers, so response times vary. Expect an acknowledgement
within about a week. If a report is valid, the fix and an advisory go out together, and you get
credit unless you would rather not.

## Scope

In scope:

- The server (`packages/server`) — web API, device API, session handling, scanner, key storage
- The USB transport (`packages/usb-host`, `NSLU` framing)
- The Switch client (`switch/`) — in particular the signed self-update path
- The Docker image and its entrypoint

Out of scope:

- Anything requiring an already-authenticated admin to attack their own server
- Physical access to an unlocked machine that is already running the server
- Vulnerabilities in devkitPro, libnx, or Borealis (report those upstream)
- Deploying the server on a hostile network without a reverse proxy or TLS, against the guidance in
  [docs/deploy.md](docs/deploy.md)

## Threat model

NSLibrary is built for a home LAN. It assumes the network is semi-trusted and the operator owns
every device on it. A few things follow from that, and are worth knowing before you file a report:

**Update signing is the highest-value target.** The Switch client pins an Ed25519 public key
(`switch/source/update/verify.cpp`) and will replace its own `.nro` with anything that verifies
against it. TLS is deliberately not trusted for this — the Switch CA store is incomplete, and the
library server could be any host on the LAN. Authenticity comes only from the signature. A flaw in
`update/verify.cpp`, `update/apply.cpp`, or the manifest parser is the most serious class of bug in
this project.

**First-run setup is a race.** Whoever reaches a fresh server first can create the admin account.
The server therefore generates a setup token on first boot and prints it to the log; anyone who
cannot read the log cannot claim the server. Set `NSLIB_SETUP_TOKEN` to choose your own. See
[docs/deploy.md](docs/deploy.md).

**A paired Switch is trusted with the catalog and your saves.** Pairing hands a device a bearer token
that can read the full library, claim install jobs, and upload and download save backups (every
console's, so a save can move between them). Uploads are checked as plain save archives, capped by
`NSLIB_SAVE_MAX_MB`, and stored under `<dataDir>/saves`; retention bounds how many backups each save
keeps, but not how many saves a device can create, so revoke a device you no longer trust. A token
cannot upload anything else, change settings, read `prod.keys`, or reach the web API. Pairing codes
are rate limited per address.

**Keys never leave the server.** `prod.keys` is stored at `<dataDir>/keys/prod.keys` with mode
`0600`. The API reports which key *names* are present and never returns, logs, or transmits key
material — including to a paired device. A path that leaks key bytes is a vulnerability; report it.

**The server never writes to library folders.** Roots are treated as read-only. A write into a
library root is a bug worth reporting even if you cannot show harm.

## Hardening

- Put the server behind a reverse proxy with TLS if it is reachable from outside your LAN, and set
  `NSLIB_TRUST_PROXY=true` so rate limiting sees real client addresses.
- Or set `NSLIB_TLS_KEY` / `NSLIB_TLS_CERT` for direct HTTPS on a LAN with no proxy.
- Mount library folders read-only (`:ro`) even though the server does not write to them.
- Set `NSLIB_DISCOVERY=0` to stop UDP and mDNS advertising on networks you do not control.
- Do not expose port 8465 to the internet without authentication in front of it.
