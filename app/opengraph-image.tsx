import { ImageResponse } from "next/og";

export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "flex-start",
          justifyContent: "center",
          background: "#06271c",
          padding: "80px",
          fontFamily: "sans-serif",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 16,
            marginBottom: 40,
          }}
        >
          <div
            style={{
              display: "flex",
              width: 64,
              height: 64,
              alignItems: "center",
              justifyContent: "center",
              background: "#22a56d",
              borderRadius: 16,
              color: "white",
              fontSize: 34,
              fontWeight: 700,
            }}
          >
            B
          </div>
          <div style={{ display: "flex", fontSize: 40, fontWeight: 700, color: "white" }}>Busihub</div>
        </div>
        <div style={{ display: "flex", fontSize: 52, fontWeight: 700, color: "white", maxWidth: 900, lineHeight: 1.15 }}>
          Run your business. Sell smarter.
        </div>
        <div style={{ display: "flex", marginTop: 24, fontSize: 26, color: "#afe9cb", maxWidth: 820 }}>
          POS, inventory, payments, customers and reports — one simple platform.
        </div>
      </div>
    ),
    { ...size }
  );
}