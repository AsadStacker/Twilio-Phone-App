import path from 'node:path';

import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  turbopack: {
    // Pin the workspace root to this project. Without it Turbopack walks up and
    // picks the home directory, which contains an unrelated lockfile.
    root: path.resolve(import.meta.dirname),
    
  },
    allowedDevOrigins: ['vito-moonish-lashingly.ngrok-free.dev'],
};

export default nextConfig;
