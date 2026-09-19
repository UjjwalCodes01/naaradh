import type { SVGProps } from 'react';

/**
 * The site's icons, drawn inline. No icon library: a handful of 24px strokes weigh less than a
 * dependency, and inline SVG inherits `currentColor` so a chip only has to set text colour.
 */
type IconProps = SVGProps<SVGSVGElement>;

const base = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.6,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
};

export function PhoneIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M6.5 3.5h3l1.5 4-2 1.4a12 12 0 0 0 6.1 6.1l1.4-2 4 1.5v3a2 2 0 0 1-2.2 2A16.5 16.5 0 0 1 4.5 5.7 2 2 0 0 1 6.5 3.5Z" />
    </svg>
  );
}

export function HeadsetIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M4 13v-1a8 8 0 0 1 16 0v1" />
      <path d="M4 13h2.2a1 1 0 0 1 1 1v3.2a1 1 0 0 1-1 1H5.6A1.6 1.6 0 0 1 4 16.6V13Z" />
      <path d="M20 13h-2.2a1 1 0 0 0-1 1v3.2a1 1 0 0 0 1 1h.6a1.6 1.6 0 0 0 1.6-1.6V13Z" />
      <path d="M18 18.5v.5a2.5 2.5 0 0 1-2.5 2.5H13" />
    </svg>
  );
}

export function BoxIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="m12 3 8 4.2v9.6L12 21l-8-4.2V7.2L12 3Z" />
      <path d="m4 7.2 8 4.2 8-4.2" />
      <path d="M12 11.4V21" />
    </svg>
  );
}

export function SmileIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M9 14.2a4 4 0 0 0 6 0" />
      <path d="M9.2 9.8h.01M14.8 9.8h.01" strokeWidth="2" />
    </svg>
  );
}

export function SparkIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M12 3.5 13.9 9l5.6 1.9-5.6 1.9L12 18.4l-1.9-5.6L4.5 10.9 10.1 9 12 3.5Z" />
      <path d="M18.5 16.5 19.3 19l2.2.8-2.2.8-.8 2.2" />
    </svg>
  );
}

export function CheckIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="m5 12.6 4.4 4.4L19 7.4" strokeWidth="2" />
    </svg>
  );
}

export function ArrowRightIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M4.5 12h14" />
      <path d="m13 6.5 5.5 5.5L13 17.5" />
    </svg>
  );
}

export function ClockIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 1.8" />
    </svg>
  );
}

export function WaveIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M3 12h1.8M7 8.5v7M10.4 5.5v13M13.8 8v8M17.2 10v4M20.5 11.4v1.2" strokeWidth="1.8" />
    </svg>
  );
}

export function ShieldIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M12 3.2 19 6v5.4c0 4.2-2.8 7.4-7 9.4-4.2-2-7-5.2-7-9.4V6l7-2.8Z" />
      <path d="m9.2 12.2 2 2 3.6-3.8" />
    </svg>
  );
}

export function LockIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <rect x="4.5" y="10.5" width="15" height="10" rx="2.2" />
      <path d="M8.2 10.5V8a3.8 3.8 0 0 1 7.6 0v2.5" />
    </svg>
  );
}

export function DocIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M6.5 3.5h7L18.5 8v12.5h-12V3.5Z" />
      <path d="M13.2 3.6V8.2h4.9" />
      <path d="M9.2 12.5h6M9.2 16h4" />
    </svg>
  );
}

export function NoCallIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M6.2 3.6h2.9l1.4 3.9-2 1.3a11.7 11.7 0 0 0 5 5.2" />
      <path d="M14.4 16.6 15.8 15l3.9 1.4v2.9a2 2 0 0 1-2.2 2c-3-.2-5.7-1.3-8-3.1" />
      <path d="M3.5 3.5 20.5 20.5" strokeWidth="1.8" />
    </svg>
  );
}

export function StoreIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M4 9.5h16L18.8 5H5.2L4 9.5Z" />
      <path d="M5 9.5v9.8h14V9.5" />
      <path d="M9.8 19.3v-5.1h4.4v5.1" />
    </svg>
  );
}

export function SlidersIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M4 6h16M4 12h16M4 18h16" />
      <circle cx="14.5" cy="6" r="2" fill="currentColor" />
      <circle cx="8.5" cy="12" r="2" fill="currentColor" />
      <circle cx="15.5" cy="18" r="2" fill="currentColor" />
    </svg>
  );
}

/** A handset with two sound arcs: "a call in progress". */
export function PhoneCallIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M6.5 3.5h3l1.5 4-2 1.4a12 12 0 0 0 6.1 6.1l1.4-2 4 1.5v3a2 2 0 0 1-2.2 2A16.5 16.5 0 0 1 4.5 5.7 2 2 0 0 1 6.5 3.5Z" />
      <path d="M14.5 3.8a6 6 0 0 1 5.7 5.7M14.3 7.2a2.8 2.8 0 0 1 2.5 2.5" />
    </svg>
  );
}

/** A filled shopping bag with an S — step one is "connect your Shopify store". */
export function ShopBagIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden {...props}>
      <path
        d="M8.2 7.2V6a3.8 3.8 0 0 1 7.6 0v1.2"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
      />
      <path
        d="M4.6 7.2h14.8l-1.1 13.1a1.6 1.6 0 0 1-1.6 1.5H7.3a1.6 1.6 0 0 1-1.6-1.5L4.6 7.2Z"
        fill="currentColor"
      />
      <path
        d="M13.9 11.4c-.5-.6-1.2-.9-2-.9-1.1 0-1.9.6-1.9 1.5 0 2 4 1.2 4 3.4 0 1-.9 1.7-2.1 1.7-.9 0-1.7-.4-2.2-1"
        fill="none"
        stroke="#fff"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** A simplified outline of India. */
export function IndiaIcon(props: IconProps) {
  return (
    <svg {...base} viewBox="3.8 1.6 17.6 21.2" {...props}>
      <path d="M9 2.2 11 2.8l1.1 1.4-.6 1.5 1.6 1 2 .6 2-.4 1.4-.6 1.6.6.9 1.1-1.2 1.2-1.6.2-.9 1.2-1.3.4-1.3 1.3-1.2 1.8-.9 2.3-.8 2.6-.7 2.8-.9-2.2-.8-2.8-1-2.6-.7-1.5-1.6.2-1.5-.9 1.2-.8-1.7-.8.9-1.4 1.6-1 .8-1.6-.7-1.3 1-1.4Z" />
    </svg>
  );
}

/** A shopping cart: cart-recovery calls. */
export function CartIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M3.5 4h2l1.4 10.2a1.8 1.8 0 0 0 1.8 1.5h7.6a1.8 1.8 0 0 0 1.8-1.5L20 8H6.2" />
      <circle cx="9.5" cy="19.5" r="1.3" fill="currentColor" stroke="none" />
      <circle cx="16.5" cy="19.5" r="1.3" fill="currentColor" stroke="none" />
    </svg>
  );
}

/** A speech bubble: post-delivery feedback. */
export function ChatIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M4 5.5h16v10.5H9.5L5.5 19v-3H4V5.5Z" />
      <path d="M8 9.5h8M8 12.5h5" />
    </svg>
  );
}

/** A calendar page: appointment reminders. */
export function CalendarIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <rect x="4" y="5" width="16" height="15" rx="2" />
      <path d="M4 9.5h16M8 3v3.5M16 3v3.5" />
      <path d="m8.7 14.2 2 2 4.2-4.4" />
    </svg>
  );
}

/** A storefront grid: works across categories. */
export function GridIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <rect x="4" y="4" width="7" height="7" rx="1.4" />
      <rect x="13" y="4" width="7" height="7" rx="1.4" />
      <rect x="4" y="13" width="7" height="7" rx="1.4" />
      <rect x="13" y="13" width="7" height="7" rx="1.4" />
    </svg>
  );
}

/** A person with a raised hand: "stops calling when asked". */
export function UserStopIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <circle cx="10" cy="7.5" r="3.5" />
      <path d="M3.5 20.5a6.5 6.5 0 0 1 11.2-4.5" />
      <path d="m16 15.5 4.5 4.5M20.5 15.5 16 20" />
    </svg>
  );
}

export function ArrowDownIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M12 4.5v14" />
      <path d="m6.5 13 5.5 5.5 5.5-5.5" />
    </svg>
  );
}

export function RupeeIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M7 5h10M7 9h10" />
      <path d="M10 5c3 0 4.6 1.6 4.6 4s-1.6 4-4.6 4H7.5l7 6" />
    </svg>
  );
}

export function StarIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path
        d="m12 3.8 2.5 5.1 5.6.8-4.1 4 1 5.6L12 16.6l-5 2.7 1-5.6-4.1-4 5.6-.8L12 3.8Z"
        fill="currentColor"
      />
    </svg>
  );
}

export function GrowthIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M5 20v-5M10 20v-8M15 20v-6M20 20V9" strokeWidth="2" />
      <path d="m4 11 5-4.5 4 3L19.5 4" />
      <path d="M16 4h3.5v3.5" />
    </svg>
  );
}

export function UserIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <circle cx="12" cy="8.5" r="3.8" />
      <path d="M4.8 20a7.2 7.2 0 0 1 14.4 0" />
    </svg>
  );
}

export function MicOffIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" />
      <path d="M4 4l16 16" />
    </svg>
  );
}

export function KeypadIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      {[6, 12, 18].flatMap((y) =>
        [6, 12, 18].map((x) => (
          <circle
            key={`${String(x)}-${String(y)}`}
            cx={x}
            cy={y}
            r="1.4"
            fill="currentColor"
            stroke="none"
          />
        )),
      )}
    </svg>
  );
}

export function SpeakerIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4v-5Z" />
      <path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11" />
    </svg>
  );
}

/** The handset turned down: end call. */
export function EndCallIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden {...props}>
      <path d="M12 9c-3.4 0-6.4 1-8.4 2.6-.5.4-.7 1.1-.5 1.7l.6 1.6c.3.7 1 1.1 1.8.9l2.7-.7c.6-.2 1-.7 1.1-1.3l.2-1.5c1.6-.4 3.4-.4 5 0l.2 1.5c.1.6.5 1.1 1.1 1.3l2.7.7c.8.2 1.5-.2 1.8-.9l.6-1.6c.2-.6 0-1.3-.5-1.7C18.4 10 15.4 9 12 9Z" />
    </svg>
  );
}

export function TagIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M3.5 12.2V4.5a1 1 0 0 1 1-1h7.7l8.3 8.3a1.4 1.4 0 0 1 0 2l-6.7 6.7a1.4 1.4 0 0 1-2 0L3.5 12.2Z" />
      <circle cx="8" cy="8" r="1.4" fill="currentColor" stroke="none" />
    </svg>
  );
}

/** A dial with the needle short of the top: "your spending cap". */
export function GaugeIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M4 17a8 8 0 1 1 16 0" />
      <path d="m12 17 3.5-5" strokeWidth="1.9" />
      <circle cx="12" cy="17" r="1.3" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function BuildingIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M5 20.5V4.5a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v16" />
      <path d="M3.5 20.5h17M9 7.5h1.5M13.5 7.5H15M9 11h1.5M13.5 11H15M9 14.5h1.5M13.5 14.5H15" />
      <path d="M10.5 20.5v-3h3v3" />
    </svg>
  );
}

export function UsersIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <circle cx="9" cy="8.5" r="3.3" />
      <path d="M3 19.5a6 6 0 0 1 12 0" />
      <path d="M15.5 5.4a3.3 3.3 0 0 1 0 6.2M17.5 14a6 6 0 0 1 3.5 5.5" />
    </svg>
  );
}

export function PlusIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M12 5.5v13M5.5 12h13" strokeWidth="1.8" />
    </svg>
  );
}

export function DotsIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <circle cx="6" cy="12" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="18" cy="12" r="1.4" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function MenuIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M4 7h16M4 12h16M4 17h16" strokeWidth="1.8" />
    </svg>
  );
}

export function CloseIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M6 6l12 12M18 6 6 18" strokeWidth="1.8" />
    </svg>
  );
}

/** Social marks are filled glyphs, not strokes. */
export function LinkedInIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden {...props}>
      <path d="M6.94 8.5H4V20h2.94V8.5ZM5.47 4a1.7 1.7 0 1 0 0 3.4 1.7 1.7 0 0 0 0-3.4ZM20 13.6c0-3.2-1.7-4.7-4-4.7-1.85 0-2.68 1.02-3.14 1.74V8.5H9.92V20h2.94v-6.3c0-1.33.25-2.62 1.9-2.62 1.63 0 1.65 1.52 1.65 2.7V20H20v-6.4Z" />
    </svg>
  );
}

export function XIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden {...props}>
      <path d="M17.2 4h2.9l-6.34 7.24L21.3 20h-5.84l-4.57-5.55L5.66 20H2.75l6.78-7.74L2.7 4h5.99l4.13 5.07L17.2 4Zm-1.02 14.3h1.61L7.9 5.62H6.17l10.01 12.68Z" />
    </svg>
  );
}

export function YouTubeIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden {...props}>
      <path d="M21.2 7.4a2.4 2.4 0 0 0-1.7-1.7C18 5.3 12 5.3 12 5.3s-6 0-7.5.4A2.4 2.4 0 0 0 2.8 7.4C2.4 8.9 2.4 12 2.4 12s0 3.1.4 4.6a2.4 2.4 0 0 0 1.7 1.7c1.5.4 7.5.4 7.5.4s6 0 7.5-.4a2.4 2.4 0 0 0 1.7-1.7c.4-1.5.4-4.6.4-4.6s0-3.1-.4-4.6ZM10.1 14.9V9.1l5 2.9-5 2.9Z" />
    </svg>
  );
}
