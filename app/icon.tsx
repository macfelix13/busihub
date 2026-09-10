import { ImageResponse } from "next/og";

// Next.js file convention: this becomes the site favicon/app icon. Reuses
// the exact "B" brand mark already used in components/layout/sidebar.tsx
// and components/marketing/navbar.tsx (bg-lime-400 chip, brand-950 text)
// rather than inventing a new logo — there is no separate logo image asset
// anywhere in the repo to draw from instead.
//
// Was bg-brand-600 (#158459) with white text until the Phase 16 (PWA) pass
// — a leftover from before the dark-green/lime redesign that nothing had
// gone back to fix, since this file renders as a route rather than
// appearing in any grep for the old color's Tailwind class name.
export const size = { width: 64, height: 64 };
export const contentType = "image/png";

export default function Icon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#b0d840",
          borderRadius: 14,
          color: "#06271c",
          fontSize: 38,
          fontWeight: 700,
          fontFamily: "sans-serif",
        }}
      >
        B
      </div>
    ),
    { ...size }
  );
}