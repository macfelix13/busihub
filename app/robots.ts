import type { MetadataRoute } from "next";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: [
        "/admin",
        "/api",
        "/dashboard",
        "/till",
        "/sales",
        "/inventory",
        "/products",
        "/customers",
        "/reports",
        "/settings",
        "/branches",
        "/expenses",
        "/purchase-orders",
        "/suppliers",
      ],
    },
    sitemap: "https://busihub.vercel.app/sitemap.xml",
  };
}