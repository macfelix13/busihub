import type { MetadataRoute } from "next";

// Only the pages that are actually public and meant to be indexed.
// Everything under app/(app)/ and app/admin/ requires sign-in and is
// blocked in robots.ts instead of listed here.
export default function sitemap(): MetadataRoute.Sitemap {
  const base = "https://busihub.vercel.app";
  const routes = ["/", "/login", "/register", "/privacy", "/terms"];

  return routes.map((route) => ({
    url: `${base}${route}`,
    lastModified: new Date(),
    changeFrequency: route === "/" ? "weekly" : "monthly",
    priority: route === "/" ? 1 : 0.5,
  }));
}