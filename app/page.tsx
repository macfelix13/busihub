import { Navbar } from "@/components/marketing/navbar";
import { Hero } from "@/components/marketing/hero";
import { TrustBar } from "@/components/marketing/trust-bar";
import { ProblemSection } from "@/components/marketing/problem-section";
import { SolutionSection } from "@/components/marketing/solution-section";
import { FeaturesSection } from "@/components/marketing/features-section";
import { ProductServiceSection } from "@/components/marketing/product-service-section";
import { PaymentsSection } from "@/components/marketing/payments-section";
import { MobileMoneySection } from "@/components/marketing/mobile-money-section";
import { BarcodeSection } from "@/components/marketing/barcode-section";
import { MultiDeviceSection } from "@/components/marketing/multi-device-section";
import { DashboardSection } from "@/components/marketing/dashboard-section";
import { StaffSection } from "@/components/marketing/staff-section";
import { SecuritySection } from "@/components/marketing/security-section";
import { HowItWorks } from "@/components/marketing/how-it-works";
import { PricingPreview } from "@/components/marketing/pricing-preview";
import { FaqSection } from "@/components/marketing/faq-section";
import { FinalCta } from "@/components/marketing/final-cta";
import { Footer } from "@/components/marketing/footer";

/**
 * The public homepage — busihub.vercel.app/. Deliberately outside every
 * route group that requires sign-in: app/(app)/layout.tsx (the
 * authenticated shell) and app/(auth)/layout.tsx (login/register) are
 * untouched by this file, and proxy.ts never redirects "/", so an
 * unauthenticated visitor lands here rather than on the dashboard or a
 * login wall.
 *
 * Every claim on this page was checked against what's actually
 * implemented in the app (see this build's PR description for the
 * file-by-file audit) rather than the wishlist a generic POS landing
 * page would make: no offline-mode section, no native-app claims, no
 * invented pricing tiers, no fabricated testimonials or customer counts.
 */
export default function HomePage() {
  return (
    <>
      <Navbar />
      <main>
        <Hero />
        <TrustBar />
        <ProblemSection />
        <SolutionSection />
        <FeaturesSection />
        <ProductServiceSection />
        <PaymentsSection />
        <MobileMoneySection />
        <BarcodeSection />
        <MultiDeviceSection />
        <DashboardSection />
        <StaffSection />
        <SecuritySection />
        <HowItWorks />
        <PricingPreview />
        <FaqSection />
        <FinalCta />
      </main>
      <Footer />
    </>
  );
}