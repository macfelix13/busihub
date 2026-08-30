"use client";

import { useFormState } from "react-dom";
import { Field } from "@/components/ui/field";
import { Select } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { SubmitButton } from "@/components/ui/button";
import type { BusinessSettingsInput } from "@/lib/validation/business-settings";
import { updateBusinessSettings, type SettingsFormState } from "./actions";

const initialState: SettingsFormState = {};

function Section({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <div className="border-t border-neutral-200 pt-5 first:border-t-0 first:pt-0 dark:border-neutral-800">
      <h3 className="font-semibold">{title}</h3>
      {description ? <p className="mt-0.5 text-sm text-neutral-500">{description}</p> : null}
      <div className="mt-4 flex flex-col gap-4">{children}</div>
    </div>
  );
}

export function BusinessSettingsForm({ defaultValues }: { defaultValues: BusinessSettingsInput }) {
  const [state, formAction] = useFormState(updateBusinessSettings, initialState);

  return (
    <form action={formAction} className="flex flex-col gap-6" noValidate>
      {state.error ? (
        <p role="alert" className="rounded-xl bg-red-50 px-3.5 py-2.5 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
          {state.error}
        </p>
      ) : null}
      {state.success ? (
        <p role="status" className="rounded-xl bg-green-50 px-3.5 py-2.5 text-sm text-green-700 dark:bg-green-950 dark:text-green-300">
          Saved.
        </p>
      ) : null}

      <Section title="Tax" description="Ghana VAT and statutory levies applied at checkout (Section 26). Rates are percentages.">
        <Checkbox label="Charge VAT" name="vatEnabled" defaultChecked={defaultValues.vatEnabled} />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="VAT rate (%)" name="vatRatePercent" type="number" step="0.01" min={0} max={100} defaultValue={defaultValues.vatRatePercent} error={state.fieldErrors?.vatRatePercent} />
          <Field label="NHIL levy (%)" name="nhilLevyRatePercent" type="number" step="0.01" min={0} max={100} defaultValue={defaultValues.nhilLevyRatePercent} error={state.fieldErrors?.nhilLevyRatePercent} />
          <Field label="GETFund levy (%)" name="getfundLevyRatePercent" type="number" step="0.01" min={0} max={100} defaultValue={defaultValues.getfundLevyRatePercent} error={state.fieldErrors?.getfundLevyRatePercent} />
          <Field label="COVID levy (%)" name="covidLevyRatePercent" type="number" step="0.01" min={0} max={100} defaultValue={defaultValues.covidLevyRatePercent} error={state.fieldErrors?.covidLevyRatePercent} />
        </div>
        <Checkbox
          label="Prices include VAT"
          description="If off, VAT is added on top of listed prices instead of already being part of them."
          name="vatInclusive"
          defaultChecked={defaultValues.vatInclusive}
        />
      </Section>

      <Section title="Receipts">
        <Field label="Receipt footer message" name="receiptFooterMessage" defaultValue={defaultValues.receiptFooterMessage} error={state.fieldErrors?.receiptFooterMessage} />
        <Select
          label="Paper size"
          name="receiptPaperSize"
          defaultValue={defaultValues.receiptPaperSize}
          error={state.fieldErrors?.receiptPaperSize}
          options={[
            { value: "thermal_58mm", label: "Thermal 58mm" },
            { value: "thermal_80mm", label: "Thermal 80mm" },
            { value: "a4", label: "A4" },
          ]}
        />
        <Checkbox label="Show logo on receipt" name="receiptShowLogo" defaultChecked={defaultValues.receiptShowLogo} />
        <Checkbox label="Show QR code on receipt" name="receiptShowQrCode" defaultChecked={defaultValues.receiptShowQrCode} />
      </Section>

      <Section title="Invoices">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Field label="Invoice prefix" name="invoicePrefix" defaultValue={defaultValues.invoicePrefix} error={state.fieldErrors?.invoicePrefix} />
          <Field label="Next invoice number" name="invoiceNextNumber" type="number" min={1} step={1} defaultValue={defaultValues.invoiceNextNumber} error={state.fieldErrors?.invoiceNextNumber} />
          <Field label="Payment due (days)" name="invoiceDueDays" type="number" min={0} step={1} defaultValue={defaultValues.invoiceDueDays} error={state.fieldErrors?.invoiceDueDays} />
        </div>
      </Section>

      <Section title="Point of sale">
        <Checkbox
          label="Allow sales when stock is negative"
          description="Off is safer for most shops â€” it stops a sale once stock hits zero."
          name="posAllowNegativeStock"
          defaultChecked={defaultValues.posAllowNegativeStock}
        />
        <Checkbox
          label="Require a customer on every sale"
          name="posRequireCustomerForSale"
          defaultChecked={defaultValues.posRequireCustomerForSale}
        />
        <Field
          label="Default discount cap (%)"
          name="posDefaultDiscountCapPercent"
          type="number"
          step="0.01"
          min={0}
          max={100}
          defaultValue={defaultValues.posDefaultDiscountCapPercent}
          error={state.fieldErrors?.posDefaultDiscountCapPercent}
        />
      </Section>

      <Section title="Inventory">
        <Field
          label="Low stock threshold"
          name="inventoryLowStockThreshold"
          type="number"
          min={0}
          step={1}
          defaultValue={defaultValues.inventoryLowStockThreshold}
          error={state.fieldErrors?.inventoryLowStockThreshold}
        />
        <Checkbox label="Track expiry dates" name="inventoryTrackExpiry" defaultChecked={defaultValues.inventoryTrackExpiry} />
        <Checkbox label="Track batches/lots" name="inventoryTrackBatches" defaultChecked={defaultValues.inventoryTrackBatches} />
      </Section>

      <Section title="Notifications">
        <Checkbox label="Low stock alerts" name="notifyLowStockAlerts" defaultChecked={defaultValues.notifyLowStockAlerts} />
        <Checkbox label="Daily summary" name="notifyDailySummary" defaultChecked={defaultValues.notifyDailySummary} />
      </Section>

      <Section title="Appearance">
        <Select
          label="Theme"
          name="appearanceTheme"
          defaultValue={defaultValues.appearanceTheme}
          error={state.fieldErrors?.appearanceTheme}
          options={[
            { value: "system", label: "Match device" },
            { value: "light", label: "Light" },
            { value: "dark", label: "Dark" },
          ]}
        />
        <Field
          label="Primary color"
          name="appearancePrimaryColor"
          type="color"
          defaultValue={defaultValues.appearancePrimaryColor}
          error={state.fieldErrors?.appearancePrimaryColor}
          className="h-11 w-20 cursor-pointer p-1"
        />
      </Section>

      <SubmitButton pendingText="Savingâ€¦" className="mt-2 self-start px-6">
        Save settings
      </SubmitButton>
    </form>
  );
}
