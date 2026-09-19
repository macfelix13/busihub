import { describe, expect, it } from "vitest";
import { businessThemeOverrideScript, resolveBusinessThemeOverride } from "@/lib/theme";

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