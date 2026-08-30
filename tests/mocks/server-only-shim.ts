// Stand-in for the "server-only" package inside Vitest. "server-only"
// works by throwing unconditionally when imported outside of Next.js's
// build-time aliasing (which swaps it for a no-op in server bundles) —
// Vitest doesn't replicate that aliasing, so importing lib/auth/pin.ts
// (which imports "server-only" to prevent an accidental client-side
// import in the real app) fails under test unless we alias it to this
// empty module instead. See vitest.config.ts.
export {};
