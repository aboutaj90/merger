import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // مجلد البناء قابل للتجاوز بمتغير البيئة (لاختبار next build دون تعارض مع خادم التطوير)
  distDir: process.env.NEXT_DIST_DIR || ".next",
  typescript: {
    ignoreBuildErrors: false,
  },
  reactStrictMode: false,
};

export default nextConfig;
