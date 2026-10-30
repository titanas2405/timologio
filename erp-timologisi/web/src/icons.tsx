import type { ReactNode } from "react";

// Εικονίδια γραμμής (SVG), ενσωματωμένα χωρίς εξωτερική βιβλιοθήκη. Παίρνουν το χρώμα του κειμένου (currentColor).

function Svg({ children }: { children: ReactNode }) {
  return (
    <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {children}
    </svg>
  );
}

export const ICONS = {
  building: (
    <Svg>
      <path d="M4 21V5a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v16" />
      <path d="M15 9h4a1 1 0 0 1 1 1v11" />
      <path d="M3 21h18M8 8h3M8 12h3M8 16h3" />
    </Svg>
  ),
  series: (
    <Svg>
      <path d="M7 3h8l4 4v13a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" />
      <path d="M15 3v4h4M9.5 11l-1 7M13.5 11l-1 7M8 13.3h7M7.5 15.8h7" />
    </Svg>
  ),
  codes: (
    <Svg>
      <path d="M4 5v14M7 5v14M11 5v14M14 5v14M18 5v14M20 5v14" />
    </Svg>
  ),
  wallet: (
    <Svg>
      <path d="M4 7a2 2 0 0 1 2-2h11v4" />
      <path d="M4 7v11a2 2 0 0 0 2 2h13a1 1 0 0 0 1-1v-9a1 1 0 0 0-1-1H6a2 2 0 0 1-2-2z" />
      <circle cx="16" cy="14.5" r="1.2" />
    </Svg>
  ),
  tag: (
    <Svg>
      <path d="M3 12V4a1 1 0 0 1 1-1h8l9 9-9 9z" />
      <circle cx="8" cy="8" r="1.5" />
      <path d="M12 15.5 15.5 12" />
    </Svg>
  ),
  cash: (
    <Svg>
      <rect x="2.5" y="6" width="19" height="12" rx="1.5" />
      <circle cx="12" cy="12" r="2.6" />
      <path d="M6 9.5v5M18 9.5v5" />
    </Svg>
  ),
  phone: (
    <Svg>
      <rect x="6.5" y="2.5" width="11" height="19" rx="2" />
      <path d="M10.5 18.5h3M9.5 9.5h5v3h-5z" />
    </Svg>
  ),
  registry: (
    <Svg>
      <rect x="3" y="5" width="13" height="14" rx="1.5" />
      <path d="M6.5 9.5h6M6.5 12.5h4" />
      <circle cx="16.5" cy="15.5" r="3" />
      <path d="M18.7 17.7 21 20" />
    </Svg>
  ),
  cloud: (
    <Svg>
      <path d="M7 18a4.5 4.5 0 0 1-.6-8.96A6 6 0 0 1 18 9.5a4.25 4.25 0 0 1-.5 8.5z" />
      <path d="m9.5 13.5 2 2 3.5-3.5" />
    </Svg>
  ),
  users: (
    <Svg>
      <circle cx="9" cy="8.5" r="3.2" />
      <path d="M3 20a6 6 0 0 1 12 0" />
      <path d="M16 5.5a3 3 0 0 1 0 6M18 14.3A6 6 0 0 1 21 20" />
    </Svg>
  ),
};

export type IconName = keyof typeof ICONS;
