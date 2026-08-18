/** @type {import('next').NextConfig} */
const nextConfig = {
  devIndicators: false,
  serverExternalPackages: [],
  async rewrites() {
    return [
      {
        source: '/v1/chat/completions',
        destination: '/api/v1/chat/completions',
      },
      {
        source: '/v1/models',
        destination: '/api/v1/models',
      },
    ];
  },
};

module.exports = nextConfig;
