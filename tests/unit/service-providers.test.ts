import { describe, expect, it } from "vitest";
import {
  serviceProviderSchema,
  serviceProviderStatusSchema,
  isAllowedPhotoFile,
  ALLOWED_PHOTO_MIME_TYPES,
  MAX_PHOTO_BYTES,
} from "@/lib/validation/service-providers";

describe("serviceProviderSchema", () => {
  const valid = {
    name: "Ama Mensah",
    title: "Braider",
    phone: "024 412 3456",
    branchId: "550e8400-e29b-41d4-a716-446655440000",
  };

  it("accepts a well-formed service provider", () => {
    expect(serviceProviderSchema.safeParse(valid).success).toBe(true);
  });

  it("requires a name", () => {
    expect(serviceProviderSchema.safeParse({ ...valid, name: "" }).success).toBe(false);
    expect(serviceProviderSchema.safeParse({ ...valid, name: "   " }).success).toBe(false);
  });

  it("accepts a blank title and a blank phone — only the name and branch are required", () => {
    const result = serviceProviderSchema.safeParse({ ...valid, title: "", phone: "" });
    expect(result.success).toBe(true);
  });

  it("requires a branch, tied to exactly one — not optional the way a customer's preferred branch is", () => {
    expect(serviceProviderSchema.safeParse({ ...valid, branchId: "" }).success).toBe(false);
    expect(serviceProviderSchema.safeParse({ ...valid, branchId: "not-a-uuid" }).success).toBe(false);
  });

  it("rejects a name or title over the column limits", () => {
    expect(serviceProviderSchema.safeParse({ ...valid, name: "a".repeat(201) }).success).toBe(false);
    expect(serviceProviderSchema.safeParse({ ...valid, title: "a".repeat(101) }).success).toBe(false);
  });
});

describe("serviceProviderStatusSchema", () => {
  it("accepts active and archived only", () => {
    expect(serviceProviderStatusSchema.safeParse("active").success).toBe(true);
    expect(serviceProviderStatusSchema.safeParse("archived").success).toBe(true);
    expect(serviceProviderStatusSchema.safeParse("deleted").success).toBe(false);
  });
});

describe("isAllowedPhotoFile", () => {
  it("accepts a small file of an allowed image type", () => {
    for (const type of ALLOWED_PHOTO_MIME_TYPES) {
      expect(isAllowedPhotoFile({ type, size: 1024 })).toBe(true);
    }
  });

  it("rejects a disallowed mime type even at a valid size", () => {
    expect(isAllowedPhotoFile({ type: "application/pdf", size: 1024 })).toBe(false);
    expect(isAllowedPhotoFile({ type: "image/gif", size: 1024 })).toBe(false);
  });

  it("rejects an empty file", () => {
    expect(isAllowedPhotoFile({ type: "image/png", size: 0 })).toBe(false);
  });

  it("rejects a file over the size cap, and accepts one right at it", () => {
    expect(isAllowedPhotoFile({ type: "image/png", size: MAX_PHOTO_BYTES + 1 })).toBe(false);
    expect(isAllowedPhotoFile({ type: "image/png", size: MAX_PHOTO_BYTES })).toBe(true);
  });
});