"use client";

import { useState } from "react";
import { useFormState } from "react-dom";
import { Field } from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import { SubmitButton } from "@/components/ui/button";
import { CATEGORY_ICONS } from "@/lib/ui/category-icons";
import type { FormState } from "./actions";

const initialState: FormState = {};

export interface CategoryFormDefaults {
  name: string;
  description: string;
  icon: string;
}

/** Create/edit form for a category, shared by products and services alike. */
export function CategoryForm({
  action,
  defaultValues,
  submitLabel,
}: {
  action: (prevState: FormState, formData: FormData) => Promise<FormState>;
  defaultValues?: CategoryFormDefaults;
  submitLabel: string;
}) {
  const [state, formAction] = useFormState(action, initialState);
  const [icon, setIcon] = useState(defaultValues?.icon ?? "");

  return (
    <form action={formAction} className="flex flex-col gap-5" noValidate>
      {state.error ? (
        <p role="alert" className="rounded-xl bg-red-50 px-3.5 py-2.5 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
          {state.error}
        </p>
      ) : null}

      <Field label="Category name" name="name" required defaultValue={defaultValues?.name} error={state.fieldErrors?.name} />
      <Textarea
        label="Description (optional)"
        name="description"
        defaultValue={defaultValues?.description}
        error={state.fieldErrors?.description}
      />

      <div className="flex flex-col gap-2">
        <span className="text-sm font-medium text-neutral-800 dark:text-neutral-200">Icon (optional)</span>
        <input type="hidden" name="icon" value={icon} />
        <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Category icon">
          <button
            type="button"
            role="radio"
            aria-checked={icon === ""}
            onClick={() => setIcon("")}
            className={`flex h-11 w-11 items-center justify-center rounded-xl border text-xs ${
              icon === "" ? "border-brand-500 bg-brand-50 dark:bg-brand-950" : "border-neutral-300 dark:border-neutral-700"
            }`}
          >
            None
          </button>
          {CATEGORY_ICONS.map(({ value, label, Icon }) => (
            <button
              type="button"
              key={value}
              role="radio"
              aria-checked={icon === value}
              aria-label={label}
              title={label}
              onClick={() => setIcon(value)}
              className={`flex h-11 w-11 items-center justify-center rounded-xl border ${
                icon === value ? "border-brand-500 bg-brand-50 dark:bg-brand-950" : "border-neutral-300 dark:border-neutral-700"
              }`}
            >
              <Icon className="h-5 w-5" aria-hidden="true" />
            </button>
          ))}
        </div>
        {state.fieldErrors?.icon ? (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">
            {state.fieldErrors.icon}
          </p>
        ) : null}
      </div>

      <SubmitButton pendingText="Saving…" className="self-start px-6">
        {submitLabel}
      </SubmitButton>
    </form>
  );
}