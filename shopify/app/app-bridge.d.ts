import type { DetailedHTMLProps, HTMLAttributes } from 'react';

// `<s-app-nav>` is rendered by App Bridge (not Polaris), so @shopify/polaris-types does not
// declare it. Its children are `<s-link>` elements.
declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      's-app-nav': DetailedHTMLProps<HTMLAttributes<HTMLElement>, HTMLElement>;
    }
  }
}
