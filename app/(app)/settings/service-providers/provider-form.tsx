"use client";

import { useRef, useState, useTransition } from "react";
import { useFormState } from "react-dom";
import { User } from "lucide-react";
import { Field } from "@/components/ui/field";
import { Select } from "@/components/ui/select";
import { Button, SubmitButton } from "@/components/ui/button";
import { removeServiceProviderPhoto, type FormState } from "./actions";

const initialState: FormState = {};

export interface ProviderFormBranch {
  id: string;
  name: string;
}

export interface ProviderFormDefaults {
  name: string;
  title: string;
  phone: string;
  branchId: string;
  /** Already resolved to a short-lived signed URL by the page — see
   *  lib/storage/service-provider-photos.ts. Null means no photo yet. */
  photoUrl: string | null;
}

/** Create/edit form for a service provider — a barber, nail tech, or
 *  similar staff member who renders services but never signs in
 *  (migration 0045). */
export function ProviderForm({
  action,
  providerId,
  branches,
  defaultValues,
  submitLabel,
}: {
  action: (prevState: FormState, formData: FormData) => Promise<FormState>;
  /** Absent on the "new" form — there is nothing to remove a photo from yet. */
  providerId?: string;
  branches: ProviderFormBranch[];
  defaultValues?: ProviderFormDefaults;
  submitLabel: string;
}) {
  const [state, formAction] = useFormState(action, initialState);
  const [preview, setPreview] = useState<string | null>(defaultValues?.photoUrl ?? null);
  // Whether `preview` is currently showing a FILE PICKED JUST NOW (not yet
  // submitted) rather than the already-saved photo. Matters for Remove:
  // clicking it while previewing a fresh, unsaved pick should only clear
  // that pick, never reach the server to delete the photo that is
  // actually still saved.
  const [hasPendingFile, setHasPendingFile] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [removePending, startRemoveTransition] = useTransition();
  const [removeError, setRemoveError] = useState<string | null>(null);

  function onPhotoChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    // A client-only preview — the actual bytes are only ever validated
    // and stored once the form is submitted (see actions.ts's
    // isAllowedPhotoFile), so this is a courtesy, not a check.
    setPreview(URL.createObjectURL(file));
    setHasPendingFile(true);
  }

  function onRemovePhoto() {
    if (fileInputRef.current) fileInputRef.current.value = "";

    if (hasPendingFile || !providerId) {
      // Either a freshly-picked, not-yet-submitted file (revert to
      // whatever was showing before it), or the "new" form, which has no
      // saved photo on the server yet to remove.
      setPreview(providerId ? (defaultValues?.photoUrl ?? null) : null);
      setHasPendingFile(false);
      return;
    }

    setRemoveError(null);
    startRemoveTransition(async () => {
      try {
        await removeServiceProviderPhoto(providerId);
        setPreview(null);
      } catch (err) {
        setRemoveError(err instanceof Error ? err.message : "Couldn't remove the photo. Please try again.");
      }
    });
  }

  return (
    <form action={formAction} className="flex flex-col gap-5" noValidate>
      {state.error ? (
        <p role="alert" className="rounded-xl bg-red-50 px-3.5 py-2.5 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
          {state.error}
        </p>
      ) : null}

      <div className="flex items-center gap-4">
        <span className="flex h-16 w-16 flex-shrink-0 items-center justify-center overflow-hidden rounded-full bg-neutral-100 dark:bg-neutral-800">
          {preview ? (
            // A signed URL (0045) or a local blob: object URL — both
            // per-viewer, dynamic strings next/image's optimizer has no
            // use for. Same plain <img> precedent as the receipt page's
            // business logo.
            // eslint-disable-next-line @next/next/no-img-element
            <img src={preview} alt="" className="h-full w-full object-cover" />
          ) : (
            <User className="h-7 w-7 text-neutral-400" aria-hidden="true" />
          )}
        </span>
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" variant="secondary" onClick={() => fileInputRef.current?.click()}>
              {preview ? "Change photo" : "Add photo"}
            </Button>
            {preview ? (
              <Button type="button" variant="ghost" onClick={onRemovePhoto} disabled={removePending}>
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
          <p className="text-sm text-neutral-500">JPEG, PNG, or WebP. Up to 5 MB. Optional.</p>
          {removeError ? <p className="text-sm text-red-600 dark:text-red-400">{removeError}</p> : null}
        </div>
      </div>

      <Field label="Name" name="name" required defaultValue={defaultValues?.name} error={state.fieldErrors?.name} />
      <Field
        label="Job title / specialty (optional)"
        name="title"
        placeholder="e.g. Barber, Nail technician, Braider"
        defaultValue={defaultValues?.title}
        error={state.fieldErrors?.title}
      />
      <Field
        label="Phone (optional)"
        name="phone"
        type="tel"
        inputMode="tel"
        placeholder="024 412 3456"
        defaultValue={defaultValues?.phone}
        error={state.fieldErrors?.phone}
      />
      <Select
        label="Branch"
        name="branchId"
        defaultValue={defaultValues?.branchId ?? ""}
        error={state.fieldErrors?.branchId}
        options={[
          { value: "", label: "Choose a branch…" },
          ...branches.map((b) => ({ value: b.id, label: b.name })),
        ]}
      />
      <p className="-mt-2 text-sm text-neutral-500">
        Which location this person works out of. Only sales rung up at this branch can name them.
      </p>

      <SubmitButton pendingText="Saving…" className="self-start px-6">
        {submitLabel}
      </SubmitButton>
    </form>
  );
}