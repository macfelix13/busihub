import { describe, expect, it } from "vitest";
import {
  businessThemeOverrideScript,
  resolveBusinessThemeOverride,
  resolvePrimaryColorOverride,
  generateAccentRamp,
  accentForegroundTriple,
  accentOverrideStyle,
  DEFAULT_PRIMARY_COLOR,
  ACCENT_SHADES,
} from "@/lib/theme";

describe("resolveBusinessThemeOverride", () => {
  it("returns the explicit choice for 'light' and 'dark'", () => {
    expect(resolveBusinessThemeOverride("light")).toBe("light");
    expect(resolveBusinessThemeOverride("dark")).toBe("dark");
  });

  it("treats 'system' as no override — every business's untouched default", () => {
    expect(resolveBusinessThemeOverride("system")).toBeNull();
  });

  it("treats missing, null, or unrecognized values as no override", () => {
    expect(resolveBusinessThemeOverride(undefined)).toBeNull();
    expect(resolveBusinessThemeOverride(null)).toBeNull();
    expect(resolveBusinessThemeOverride("")).toBeNull();
    expect(resolveBusinessThemeOverride("darkish")).toBeNull();
  });
});

describe("businessThemeOverrideScript", () => {
  it("bails out early when the device already has a stored preference", () => {
    const script = businessThemeOverrideScript("dark");
    expect(script).toContain("localStorage.getItem('busihub-theme')");
    expect(script).toContain("return;");
  });

  it("toggles the dark class on when the business default is 'dark'", () => {
    const script = businessThemeOverrideScript("dark");
    expect(script).toContain("classList.toggle('dark', true)");
  });

  it("toggles the dark class off when the business default is 'light'", () => {
    const script = businessThemeOverrideScript("light");
    expect(script).toContain("classList.toggle('dark', false)");
  });
});

describe("resolvePrimaryColorOverride", () => {
  it("returns a normalized hex for a genuinely customized color", () => {
    expect(resolvePrimaryColorOverride("#3366CC")).toBe("#3366cc");
  });

  it("treats the untouched factory default as no override, case-insensitively", () => {
    expect(resolvePrimaryColorOverride(DEFAULT_PRIMARY_COLOR)).toBeNull();
    expect(resolvePrimaryColorOverride(DEFAULT_PRIMARY_COLOR.toUpperCase())).toBeNull();
  });

  it("treats missing, null, or malformed values as no override rather than breaking the page", () => {
    expect(resolvePrimaryColorOverride(undefined)).toBeNull();
    expect(resolvePrimaryColorOverride(null)).toBeNull();
    expect(resolvePrimaryColorOverride("")).toBeNull();
    expect(resolvePrimaryColorOverride("not-a-color")).toBeNull();
    expect(resolvePrimaryColorOverride("#fff")).toBeNull(); // 3-digit shorthand not supported
    expect(resolvePrimaryColorOverride("rgb(1,2,3)")).toBeNull();
  });
});

describe("generateAccentRamp", () => {
  it("produces every documented shade as a space-separated R G B triple", () => {
    const ramp = generateAccentRamp("#3366cc");
    for (const shade of ACCENT_SHADES) {
      expect(ramp[shade]).toMatch(/^\d{1,3} \d{1,3} \d{1,3}$/);
    }
  });

  it("gets lighter from 50 toward 900, monotonically, for a mid-tone input", () => {
    const ramp = generateAccentRamp("#3366cc");
    const luminanceOf = (triple: string) => {
      const [r, g, b] = triple.split(" ").map(Number);
      return (r ?? 0) + (g ?? 0) + (b ?? 0);
    };
    for (let i = 0; i < ACCENT_SHADES.length - 1; i++) {
      const current = luminanceOf(ramp[ACCENT_SHADES[i]!]);
      const next = luminanceOf(ramp[ACCENT_SHADES[i + 1]!]);
      expect(current).toBeGreaterThan(next);
    }
  });

  it("keeps a grayscale input grayscale (no hue leaks in from rounding)", () => {
    const ramp = generateAccentRamp("#808080");
    for (const shade of ACCENT_SHADES) {
      const [r, g, b] = ramp[shade]!.split(" ").map(Number);
      expect(r).toBe(g);
      expect(g).toBe(b);
    }
  });

  it("is deterministic — same input always produces the same ramp", () => {
    expect(generateAccentRamp("#22a56d")).toEqual(generateAccentRamp("#22a56d"));
  });
});

describe("accentForegroundTriple", () => {
  it("picks dark text for a light accent shade", () => {
    expect(accentForegroundTriple("232 247 115")).toBe("8 44 36"); // lime-300, very light
  });

  it("picks white text for a dark accent shade", () => {
    expect(accentForegroundTriple("18 44 90")).toBe("255 255 255"); // a dark navy
  });
});

describe("accentOverrideStyle", () => {
  it("sets every brand and lime shade plus accent-fg, and never brand-950", () => {
    const style = accentOverrideStyle("#3366cc");
    for (const shade of ACCENT_SHADES) {
      expect(style).toContain(`--brand-${shade}:`);
      expect(style).toContain(`--lime-${shade}:`);
    }
    expect(style).toContain("--accent-fg:");
    expect(style).not.toContain("--brand-950:");
  });

  it("wraps the declarations in a :root block", () => {
    const style = accentOverrideStyle("#3366cc");
    expect(style.trim().startsWith(":root {")).toBe(true);
    expect(style.trim().endsWith("}")).toBe(true);
  });
});