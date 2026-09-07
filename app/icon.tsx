import { ImageResponse } from "next/og";

// Next.js file convention: this becomes the site favicon/app icon. Reuses
// the exact "B" brand mark already used in app/(auth)/layout.tsx
// (bg-brand-600 rounded chip) rather than inventing a new logo — there is
// no separate logo image asset anywhere in the repo to draw from instead.
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
          background: "#158459",
          borderRadius: 14,
          color: "white",
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