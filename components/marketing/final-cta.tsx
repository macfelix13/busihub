import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";

export function FinalCta() {
  return (
    <section className="border-t border-neutral-200 dark:border-neutral-800">
      <div className="mx-auto max-w-4xl px-5 py-16 text-center sm:px-6 sm:py-24">
        <h2 className="text-balance text-3xl font-semibold tracking-tight text-neutral-900 dark:text-white sm:text-4xl">
          Ready to run your business smarter?
        </h2>
        <p className="mx-auto mt-4 max-w-xl text-pretty text-base text-neutral-600 dark:text-neutral-400">
          Set up your business, start selling, and keep everything under control with Busihub.
        </p>
        <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
          <Link href="/register">
            <Button className="w-full px-6 sm:w-auto">
              Get started <ArrowRight className="h-4 w-4" />
            </Button>
          </Link>
          <Link href="/login">
            <Button variant="secondary" className="w-full px-6 sm:w-auto">
              Sign in
            </Button>
          </Link>
        </div>
      </div>
    </section>
  );
}