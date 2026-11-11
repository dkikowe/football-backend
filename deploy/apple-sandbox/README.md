# Isolated Apple Sandbox match worker — PREPARED, NOT RUNNING

2026-11-11: the public Sandbox API is live at https://api-apple-sandbox-apple-sandbox.up.railway.app, with independent PostgreSQL/Redis volumes and credentials. The production API and all production wallets remain separate. The current VPS has 458 MiB RAM, about 129 MiB available, no swap, and an active production Unity process consuming about 160 MiB. Starting a second worker is unsafe; these files were prepared but **not installed or launched**.

## Capacity prerequisite and resize plan

Use a 2 GiB RAM DigitalOcean Droplet (same host after approved resize, or a separate host). For the existing host select a CPU/RAM-only resize, keep the current disk unchanged, and verify the exact target and price in the provider UI. Do not confirm an automatic disk expansion: CPU/RAM-only resizing preserves the option to return to the old plan; a larger disk cannot simply be shrunk. A resize requires a maintenance interval and interrupts the VPS, including its existing non-football application. Do not shut down until the user approves timing and the active football match has finished.

Before resize: verify no active match, record the existing release symlink, service state, UDP7777 listener, nginx listener and disk identity; take/verify a provider snapshot according to its current retention/cost. Shut down cleanly, resize CPU/RAM only, boot, and verify the existing production service/API registration/nginx first. Preserve `/opt/football/current`, `/etc/football/server.env`, production DTLS and all data. On boot failure, inspect provider console; revert CPU/RAM sizing if supported without touching the disk. Use the snapshot only as an explicit recovery action, never silently overwrite current data.

The new unit additionally refuses startup unless total RAM is at least 1.5 GiB and MemAvailable at least 320 MiB. Its separate memory/CPU limits and higher OOM score prioritize production; these do not replace real capacity or a multiplayer validation.

## Install only after capacity and maintenance approval

1. Create a separate `football-sandbox` system user and directories `/etc/football-sandbox` (root-only), `/opt/football-sandbox`, and `/var/lib/football-sandbox`. Keep the production service/account unchanged.
2. Point `/opt/football-sandbox/current` at an immutable, protocol-compatible Linux server release. The currently deployed production release is `/opt/football/releases/linux-expanded-build10-20261021`; verify it matches the client before reusing its read-only files. Do not point at the mutable production `current` symlink. New client gameplay changes may require a fresh Linux build.
3. Install `capacity-check.sh` as `/usr/local/libexec/football-sandbox-capacity-check` (root:root,0755), `renew-certificate.sh` as `/usr/local/sbin/renew-football-sandbox-certificate` (root:root,0755), and the three systemd files into `/etc/systemd/system`. The renewal helper creates fresh sandbox-only CA/leaf keys; never copy production private keys.
4. Fill `/etc/football-sandbox/server.env` from the template using the **Sandbox API** `GAME_SERVER_SECRET`, transferred without logs, and set root:root,0600. Do not save the filled file in this repository. State/outbox and HOME belong only to `football-sandbox`.
5. Run the sandbox certificate helper. Configure only sandbox Railway API `TRANSPORT_CA_CERTIFICATE` with the resulting public CA PEM and `TRANSPORT_SERVER_NAME=football-game-sandbox`. Set sandbox `REGIONS_JSON` to `us-east` with its own HTTPS probe. No private certificate key goes into Railway/client.
6. Add only UDP7778 to the firewall, leaving UDP7777/SSH/nginx/port80 rules intact. Enable the new sandbox unit and renewal timer after `systemd-analyze verify`. Never restart the production unit as part of sandbox installation.
7. Verify sandbox API registration for `apple-sandbox-nyc1-1`, DTLS and a real sandbox 1v1 or 3v3 match, result persistence and purchases against only the sandbox wallet. Recheck production service PID/registration/health and nginx. Record memory/CPU during the match before declaring readiness.

## Why the current single process cannot be shared

`OnlineRuntimeConfig.Load` reads one BACKEND_URL/server identity at startup. `OnlineServerAuthority.ServerLifecycle` registers/heartbeats only that backend, and all join/result requests use that one GAME_SERVER_SECRET. Switching environments in a shared process would require a new scheduler and credential/result routing, risking crossed wallet rewards. No such refactor is made.

## Isolation and current limitation

The prepared worker uses UDP7778, a separate account, state/outbox, server key, DTLS trust and API/database. Until it is installed on sufficient capacity, Sandbox authentication and purchase APIs work, but online sandbox matches have no available game worker. Do not ship an automatic TestFlight/App Review sandbox route as fully multiplayer-ready until this is resolved. Production purchases remain disabled pending genuine signed Apple device purchase tests.
