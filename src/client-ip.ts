import { BlockList, isIP } from "node:net";
import type { Request } from "express";

/** Only the configured direct proxy may supply the single X-Real-IP address. */
export function clientIpResolver(cidrs: string) {
  const trusted = new BlockList();
  for (const value of cidrs
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean)) {
    const parts = value.split("/"),
      address = parts[0],
      family = isIP(address);
    const bits =
      parts.length === 1 ? (family === 4 ? 32 : 128) : Number(parts[1]);
    if (
      !family ||
      parts.length > 2 ||
      !Number.isInteger(bits) ||
      bits < 1 ||
      bits > (family === 4 ? 32 : 128)
    )
      throw new Error(
        "TRUSTED_PROXY_CIDRS must contain explicit IPs or non-wildcard CIDRs.",
      );
    trusted.addSubnet(address, bits, family === 4 ? "ipv4" : "ipv6");
  }
  return (req: Pick<Request, "socket" | "headers">): string => {
    const peer = req.socket.remoteAddress || "unknown",
      family = isIP(peer);
    const forwarded = req.headers["x-real-ip"];
    if (
      !family ||
      !trusted.check(peer, family === 4 ? "ipv4" : "ipv6") ||
      typeof forwarded !== "string" ||
      !isIP(forwarded)
    )
      return peer;
    // IPv6 equivalent spellings must share a rate-limit bucket.
    return isIP(forwarded) === 6
      ? new URL(`http://[${forwarded}]`).hostname.slice(1, -1)
      : forwarded;
  };
}
