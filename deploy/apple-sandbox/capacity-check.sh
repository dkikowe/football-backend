#!/bin/sh
set -eu
# Fail closed on the existing 458MiB host; reserve headroom for production.
awk '/^MemTotal:/{total=$2}/^MemAvailable:/{available=$2}END{if(total<1572864 || available<327680){print "Sandbox worker requires >=1.5GiB total and >=320MiB available; production has priority." > "/dev/stderr";exit 1}}' /proc/meminfo
