# Dedicated VPS deployment

API: https://api-production-faa76.up.railway.app (Railway, PostgreSQL, Redis).
Unity dedicated: `167.172.156.89:7777/UDP`, verified host region `nyc1`, API region ID `us-east`.
This directory contains only service configuration; obtain the Linux build from the Unity project.
Never upload the Mac `.app` as a Linux executable.

## Isolation and lifecycle

The existing nginx/port 80 is independent. The dedicated service runs as the
`football` system account from `/opt/football/current/FootballServer`. Releases
live under `/opt/football/releases`. Its writable state/outbox is
`/var/lib/football`; private environment is `/etc/football/server.env` (root:root,0600).
Systemd restarts the one-match process after each completed match. One process
currently supplies one simultaneous 3v3 match. CPU is capped at75%, memory high
at200MiB and hard limit240MiB on the supplied458MiB VPS. Do not increase concurrency
without measuring memory/tick timing and provisioning capacity.

```sh
systemctl status football-server
journalctl -u football-server --since '-10 minutes'
systemctl show football-server -p MemoryCurrent -p MemoryPeak -p CPUUsageNSec
```

Restarting the unit interrupts its active match. Stop/drain between matches before
switching release symlinks. API and game-server credentials must agree; they are
in protected environment only, never in this repository or client binaries.

## DTLS trust and renewal

The server owns `/etc/football/pki/ca.key` in a0700 root-only directory. The CA's
public certificate is configured as Railway `TRANSPORT_CA_CERTIFICATE` and
`TRANSPORT_SERVER_NAME=football-game`. Clients obtain this trust over the HTTPS
API and connect to the explicit IP, so no DNS record or HTTP certificate challenge
is required. The private leaf key remains `/etc/football/tls/server.key`,0640
root:football. Only UDP7777 was added to UFW; public database ports remain closed.

`football-certificate.timer` checks daily. The90-day leaf renews with30days
remaining; each new match process loads the certificate without interrupting an
active match. The5-year CA is not silently replaced if lost. Back up the CA key
securely outside Git and plan a coordinated CA rotation before expiration.

The current single-region probe URL measures HTTPS API reachability, not UDP game
latency. Gameplay RTT is measured by Unity's live transport. The Railway API is
in Singapore and the supplied game VPS is in New York; a closer/larger game host
is recommended before production scaling, after actual match profiling.
