export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-canvas px-4 py-12 dark:bg-canvas-dark">
      <div className="w-full max-w-md">
        <div className="mb-8 flex items-center justify-center gap-2">
          <span className="rounded-lg bg-brand-950 px-2 py-1 text-sm font-bold text-lime-400">B</span>
          <span className="text-lg font-semibold">Busihub</span>
        </div>
        <div className="rounded-2xl border border-neutral-200 bg-white p-6 shadow-sm dark:border-neutral-800 dark:bg-neutral-900 sm:p-8">
          {children}
        </div>
      </div>
    </div>
  );
}