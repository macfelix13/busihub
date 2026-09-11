import { Smartphone, Tablet, Laptop, Monitor } from "lucide-react";
import { SectionHeading } from "./section-heading";

const DEVICES = [
  { icon: Smartphone, label: "Phone" },
  { icon: Tablet, label: "Tablet" },
  { icon: Laptop, label: "Laptop" },
  { icon: Monitor, label: "Desktop" },
];

/**
 * Busihub is a responsive web app — there's no Capacitor/Electron/React
 * Native project anywhere in this repo, so "works on every device" is
 * scoped honestly to "through the web app" rather than implying a native
 * install.
 */
export function MultiDeviceSection() {
  return (
    <section className="mx-auto max-w-6xl px-5 py-16 sm:px-6 sm:py-24">
      <SectionHeading
        title="Your business doesn't stop at one device."
        description="Access Busihub from supported phones, tablets, laptops and desktop computers through the web app — no separate install needed."
      />
      <div className="mx-auto mt-10 flex max-w-2xl flex-wrap items-center justify-center gap-6 sm:gap-10">
        {DEVICES.map((device) => (
          <div key={device.label} className="flex flex-col items-center gap-2">
            <div className="flex h-14 w-14 items-center justify-center rounded-2xl border border-neutral-200 bg-white text-brand-700 dark:border-surface-line dark:bg-surface-card dark:text-brand-300">
              <device.icon className="h-6 w-6" />
            </div>
            <span className="text-sm font-medium text-neutral-600 dark:text-ink-muted">{device.label}</span>
          </div>
        ))}
      </div>
    </section>
  );
}