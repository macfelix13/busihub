export default function HomePage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col items-start justify-center gap-4 px-6 py-24">
      <span className="rounded-full bg-brand-100 px-3 py-1 text-sm font-medium text-brand-800">
        Busihub
      </span>
      <h1 className="text-4xl font-semibold tracking-tight sm:text-5xl">
        Point of Sale, built for how you actually run your shop.
      </h1>
      <p className="text-lg text-neutral-600 dark:text-neutral-300">
        This is the foundation build of Busihub — multi-tenant architecture,
        authentication, and role-based access are being assembled first. The
        POS, inventory, and payments experience follows in the phases after.
      </p>
    </main>
  );
}
