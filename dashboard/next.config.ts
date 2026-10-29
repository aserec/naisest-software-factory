import type { NextConfig } from "next";

const config: NextConfig = {
  transpilePackages: ["software-factory"],
  output: "standalone",
};

export default config;
