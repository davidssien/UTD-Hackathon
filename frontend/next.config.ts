import { networkInterfaces } from 'node:os';
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Only this machine's LAN addresses and an explicitly configured tunnel.
  allowedDevOrigins: [
    ...Object.values(networkInterfaces()).flatMap(list => (list ?? []).filter(a => a.family === 'IPv4' && !a.internal).map(a => a.address)),
    ...(process.env.IMPORT_PUBLIC_ORIGIN ? [new URL(process.env.IMPORT_PUBLIC_ORIGIN).hostname] : []),
  ],
  experimental: {
    agentFeedback: true,
  },
  cacheComponents: true,
  partialPrefetching: true,
};

export default nextConfig;
