import type { Metadata } from 'next';
import { PricingView } from './pricing-view';

export const metadata: Metadata = {
  title: 'Pricing',
  description:
    'Simple monthly plans for COD confirmation calls and a 24/7 AI support line. Billed only on a clear answer or a connected minute. Prices in INR, excluding GST.',
  alternates: { languages: { 'en-US': '/pricing/us' } },
};

export default function Pricing() {
  return <PricingView market="in" />;
}
