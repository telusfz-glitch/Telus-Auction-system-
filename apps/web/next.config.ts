import type { NextConfig } from 'next';

const config: NextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  // @telus/shared is TypeScript source inside the monorepo.
  transpilePackages: ['@telus/shared'],
  experimental: {
    serverActions: {
      bodySizeLimit: '256kb',
      // Server actions are only accepted from these origins (Next also compares Origin with Host). Add the public
      // hostname here when the app runs behind a proxy that rewrites Host.
      allowedOrigins: process.env.WEB_ALLOWED_ORIGINS ? process.env.WEB_ALLOWED_ORIGINS.split(',') : undefined,
    },
  },
};
export default config;
