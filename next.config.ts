import type { NextConfig } from "next";

const publicBasePath = process.env.LIONLOG_BASE_PATH ?? "";
if (publicBasePath !== "" && !/^\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(publicBasePath)) {
  throw new Error("LIONLOG_BASE_PATH must be empty or one absolute single path segment such as /lionlog.");
}

const nextConfig: NextConfig = {
  output: "export",
};

export default nextConfig;
