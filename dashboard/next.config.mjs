/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // standalone emits a self-contained server so the docker image copies one
  // directory instead of a pnpm workspace's symlink forest
  output: 'standalone',
};

export default nextConfig;
