/**
 * Browser-only: downscales/re-encodes a picked product photo BEFORE it
 * ever leaves the device. A phone-camera original is routinely 3-8 MB —
 * fine as a one-time upload, but a real, repeated data cost once it's
 * something the till grid fetches on every shift, on every device, often
 * over shop wifi or mobile data (see migration 0046's file header). This
 * runs once, at upload time, not on every later view.
 *
 * Never a requirement for the upload to succeed: any failure here (an
 * unsupported format, a browser quirk, a source that's already small)
 * falls back to the original file untouched, and the server independently
 * re-checks size/type before anything touches storage either way
 * (lib/validation/products.ts's isAllowedProductPhotoFile) — this is
 * purely a bandwidth optimization layered on top of that.
 */
export async function downscalePhotoForUpload(file: File, maxDimension = 1024, quality = 0.82): Promise<File> {
  // Already small enough that re-encoding isn't worth the risk of making
  // it bigger (a small or already-compressed source can re-encode LARGER
  // as JPEG) or losing quality for no real gain — a pre-cropped image, a
  // screenshot, or anything already downscaled elsewhere.
  if (file.size <= 300 * 1024) return file;

  if (typeof document === "undefined" || typeof createImageBitmap !== "function") {
    return file;
  }

  let bitmap: ImageBitmap | null = null;
  try {
    bitmap = await createImageBitmap(file);
    const scale = Math.min(1, maxDimension / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return file;

    ctx.drawImage(bitmap, 0, 0, width, height);

    const blob: Blob | null = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
    if (!blob || blob.size >= file.size) return file;

    const newName = file.name.replace(/\.[^./\\]+$/, "") + ".jpg";
    return new File([blob], newName, { type: "image/jpeg" });
  } catch (err) {
    console.error("downscalePhotoForUpload: falling back to the original file", err);
    return file;
  } finally {
    bitmap?.close();
  }
}