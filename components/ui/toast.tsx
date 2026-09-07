"use client";

import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { CheckCircle2, XCircle, Info, X } from "lucide-react";
import { cn } from "@/lib/utils";

type ToastType = "success" | "error" | "info";

interface ToastItem {
  id: number;
  type: ToastType;
  message: string;
}

interface ToastContextValue {
  show: (type: ToastType, message: string) => void;
  success: (message: string) => void;
  error: (message: string) => void;
  info: (message: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

const ICONS: Record<ToastType, typeof CheckCircle2> = {
  success: CheckCircle2,
  error: XCircle,
  info: Info,
};

const ICON_CLASSES: Record<ToastType, string> = {
  success: "text-green-600 dark:text-green-400",
  error: "text-red-600 dark:text-red-400",
  info: "text-blue-600 dark:text-blue-400",
};

const AUTO_DISMISS_MS = 5000;

/**
 * The toast system this app didn't have. Until now, a client-side action
 * either showed its result inline on the page (a red box for a
 * useFormState error, which stays on screen and is genuinely the right
 * place for field-level errors) or showed nothing at all once it
 * succeeded. This is for the gap: a brief, dismissible confirmation or
 * error for something that just happened, without a permanent on-page
 * banner or a full reload. It does not replace inline field errors —
 * the two are complementary, not either/or.
 *
 * Mounted once, in the root layout (app/layout.tsx), so any client
 * component anywhere in the tree can call useToast() without needing its
 * own provider.
 *
 * Auto-dismisses after 5s but is also individually closeable, and is
 * announced via aria-live so a screen reader user hears it without
 * needing to find and focus it.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const nextId = useRef(0);

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const show = useCallback(
    (type: ToastType, message: string) => {
      const id = nextId.current++;
      setToasts((prev) => [...prev, { id, type, message }]);
      window.setTimeout(() => dismiss(id), AUTO_DISMISS_MS);
    },
    [dismiss]
  );

  const value = useMemo<ToastContextValue>(
    () => ({
      show,
      success: (message: string) => show("success", message),
      error: (message: string) => show("error", message),
      info: (message: string) => show("info", message),
    }),
    [show]
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        className="pointer-events-none fixed inset-x-0 top-0 z-[100] flex flex-col items-stretch gap-2 p-4 sm:inset-x-auto sm:right-0 sm:items-end"
        aria-live="polite"
        aria-atomic="false"
      >
        {toasts.map((toast) => {
          const Icon = ICONS[toast.type];
          return (
            <div
              key={toast.id}
              role={toast.type === "error" ? "alert" : "status"}
              className="pointer-events-auto flex w-full items-start gap-3 rounded-xl border border-neutral-200 bg-white p-3.5 shadow-lg animate-slide-down dark:border-neutral-800 dark:bg-neutral-900 sm:w-full sm:max-w-sm"
            >
              <Icon className={cn("mt-0.5 h-5 w-5 flex-shrink-0", ICON_CLASSES[toast.type])} aria-hidden="true" />
              <p className="min-w-0 flex-1 text-sm text-neutral-700 dark:text-neutral-200">{toast.message}</p>
              <button
                type="button"
                onClick={() => dismiss(toast.id)}
                aria-label="Dismiss notification"
                className="flex-shrink-0 rounded-lg p-1 text-neutral-400 transition-colors hover:bg-neutral-100 hover:text-neutral-600 dark:hover:bg-neutral-800 dark:hover:text-neutral-300"
              >
                <X className="h-4 w-4" aria-hidden="true" />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

/**
 * Reads the toast API from context. Throws (rather than silently doing
 * nothing) when called outside <ToastProvider> — that provider is mounted
 * once at the root layout, so hitting this error means something is
 * rendering outside the normal app tree, worth surfacing loudly in
 * development rather than swallowing.
 */
export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast() must be used within <ToastProvider>");
  return ctx;
}