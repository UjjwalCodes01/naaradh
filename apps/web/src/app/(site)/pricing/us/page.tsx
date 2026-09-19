import type { Metadata } from 'next';
import { PricingView } from '../pricing-view';

export const metadata: Metadata = {
  title: 'US pricing',
  description:
    'Monthly plans in US dollars for AI order and appointment confirmation calls. Billed only when a customer gives a clear answer. US calling is in early access.',
  alternates: { languages: { 'en-IN': '/pricing' } },
};

export default function UsPricing() {
  return <PricingView market="us" />;
}
