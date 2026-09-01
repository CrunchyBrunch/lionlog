import type { NextConfig } from "next";

const basePath = process.env.LIONLOG_BASE_PATH ?? "";
if (basePath !== "" && !/^\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(basePath)) {
  throw new Error("LIONLOG_BASE_PATH must be empty or one absolute single path segment such as /lionlog.");
}

const nextConfig: NextConfig = {
  basePath,
};

export default nextConfig;
