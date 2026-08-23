import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  webpack: (config,{isServer}) => {
    config.externals.push("pino-pretty", "lokijs", "encoding");
    if (!isServer) {
      config.resolve.fallback = {
        ...config.resolve.fallback,
        fs: false,
        net: false,
        tls: false,
        child_process: false,
        // 关键：解决 wagmi/viem 的 accounts 模块解析问题
        accounts: false,
        '@react-native-async-storage/async-storage': false,
      };
    }
    return config;
  },
  typescript: {
    ignoreBuildErrors: true,
  }
};

export default nextConfig;

