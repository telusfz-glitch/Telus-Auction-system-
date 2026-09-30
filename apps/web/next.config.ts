import type { NextConfig } from 'next';
import { join } from 'path';

const config: NextConfig = {
  poweredByHeader: false,
  // Docker builds set NEXT_OUTPUT=standalone: a minimal server bundle (node .next/standalone/apps/web/server.js).
  output: process.env.NEXT_OUTPUT === 'standalone' ? 'standalone' : undefined,
  outputFileTracingRoot: process.env.NEXT_OUTPUT === 'standalone' ? join(__dirname, '../..') : undefined,
  reactStrictMode: true,
  // @telus/shared is TypeScript source inside the monorepo.
  transpilePackages: ['@telus/shared'],
  experimental: {
    serverActions: {
      bodySizeLimit: '3mb',   // the Excel lot import (2 MB file cap, enforced again in the action)
      // Server actions are only accepted from these origins (Next also compares Origin with Host). Add the public
      // hostname here when the app runs behind a proxy that rewrites Host.
      allowedOrigins: process.env.WEB_ALLOWED_ORIGINS ? process.env.WEB_ALLOWED_ORIGINS.split(',') : undefined,
    },
  },
};
export default config;
