import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /**
   * Static export (brief section 10).
   *
   * Turned on NOW, in milestone 4, not at deployment in milestone 8. Static
   * export removes whole categories of Next.js feature -- server actions, route
   * handlers, server-side rendering, image optimisation, middleware. Finding
   * that out while writing the screens costs an afternoon. Finding it out the
   * week you planned to deploy costs the deadline.
   */
  output: "export",
  /** Emits /inventory/index.html rather than /inventory.html, which is what
   *  static hosts expect when serving a clean URL. */
  trailingSlash: true,
  /** The export has no server, so there is no image optimiser to call. */
  images: { unoptimized: true },
  turbopack: {
    rules: {
      "*.css": { loaders: ["@tailwindcss/turbopack"], as: "*.css" },
    },
  },
};

export default nextConfig;
