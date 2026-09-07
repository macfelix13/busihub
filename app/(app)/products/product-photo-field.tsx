"use client";

import { useRef, useState, useTransition } from "react";
import { Image as ImageIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { downscalePhotoForUpload } from "@/lib/images/downscale-photo-client";

/**
 * Create/edit photo picker shared by product-form.tsx and
 * product-details-form.tsx (migration 0046) — same interaction pattern as
 * settings/service-providers/provider-form.tsx's avatar picker (preview,
 * Change/Remove, a hidden file input named "photo" the surrounding form
 * submits as-is), but square rather than circular (a product photo, not a
 * headshot) and with one addition: a picked file is downscaled/re-encoded
 * client-side before it's ever attached to the form — see
 * lib/images/downscale-photo-client.ts for why that matters here.
 */
export function ProductPhotoField({
  defaultPhotoUrl,
  onRemove,
}: {
  /** Already resolved to a short-lived signed URL by the page. Null means no photo yet. */
  defaultPhotoUrl: string | null;
  /** Present only on the edit form — there is nothing saved to remove yet on "new". */
  onRemove?: () => Promise<void>;
}) {
  const [preview, setPreview] = useState<string | null>(defaultPhotoUrl);
  // Whether `preview` is showing a FILE PICKED JUST NOW (not yet
  // submitted) rather than the already-saved photo — see provider-form.tsx
  // for why Remove needs to tell these apart.
  const [hasPendingFile, setHasPendingFile] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [removePending, startRemoveTransition] = useTransition();
  const [removeError, setRemoveError] = useState<string | null>(null);

  async function onPhotoChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    // Immediate feedback from the original pick — the downscale below can
    // take a moment on a large photo, and this is a courtesy preview
    // either way, not what actually gets validated/stored.
    setPreview(URL.createObjectURL(file));
    setHasPendingFile(true);
    setPreparing(true);

    try {
      const resized = await downscalePhotoForUpload(file);
      if (resized !== file && fileInputRef.current) {
        // Native file inputs can't have their FileList assigned directly —
        // DataTransfer is the standard way to swap in a different File
        // after the fact while keeping this a normal, uncontrolled
        // <input type="file"> the surrounding <form> submits as-is.
        const dataTransfer = new DataTransfer();
        dataTransfer.items.add(resized);
        fileInputRef.current.files = dataTransfer.files;
        setPreview(URL.createObjectURL(resized));
      }
    } finally {
      setPreparing(false);
    }
  }

  function onRemoveClick() {
    if (fileInputRef.current) fileInputRef.current.value = "";

    if (hasPendingFile || !onRemove) {
      // Either a freshly-picked, not-yet-submitted file (revert to
      // whatever was showing before it), or the "new" form, which has no
      // saved photo on the server yet to remove.
      setPreview(onRemove ? defaultPhotoUrl : null);
      setHasPendingFile(false);
      return;
    }

    setRemoveError(null);
    startRemoveTransition(async () => {
      try {
        await onRemove();
        setPreview(null);
      } catch (err) {
        setRemoveError(err instanceof Error ? err.message : "Couldn't remove the photo. Please try again.");
      }
    });
  }

  return (
    <div className="flex items-center gap-4">
      <span className="flex h-20 w-20 flex-shrink-0 items-center justify-center overflow-hidden rounded-xl bg-neutral-100 dark:bg-neutral-800">
        {preview ? (
          // A signed URL (0046) or a local blob: object URL — both
          // per-viewer, dynamic strings next/image's optimizer has no use
          // for. Same plain <img> precedent as provider-form.tsx.
          // eslint-disable-next-line @next/next/no-img-element
          <img src={preview} alt="" className="h-full w-full object-cover" />
        ) : (
          <ImageIcon className="h-8 w-8 text-neutral-400" aria-hidden="true" />
        )}
      </span>
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="secondary" onClick={() => fileInputRef.current?.click()}>
            {preview ? "Change photo" : "Add photo"}
          </Button>
          {preview ? (
            <Button type="button" variant="ghost" onClick={onRemoveClick} disabled={removePending}>
              {removePending ? "Removing…" : "Remove"}
            </Button>
          ) : null}
        </div>
        <input
          ref={fileInputRef}
          type="file"
          name="photo"
          accept="image/jpeg,image/png,image/webp"
          onChange={onPhotoChange}
          className="hidden"
        />
        <p className="text-sm text-neutral-500">
          {preparing ? "Preparing photo…" : "JPEG, PNG, or WebP. Up to 5 MB. Optional."}
        </p>
        {removeError ? <p className="text-sm text-red-600 dark:text-red-400">{removeError}</p> : null}
      </div>
    </div>
  );
}