import { useEffect, useState, type ButtonHTMLAttributes, type ReactNode, type Ref } from "react";

/** The few shared pieces DESIGN.md asks for: icons, IconButton, Badge, Skeleton, and a media-query hook. */

const paths = {
  menu: "M4 6h16M4 12h16M4 18h16",
  plus: "M12 5v14M5 12h14",
  close: "M6 6l12 12M18 6L6 18",
  send: "M5 12h14M13 6l6 6-6 6",
  copy: "M9 9h10v10H9zM5 15V5h10",
  check: "M5 12l5 5L19 7",
  up: "M7 11v9H4v-9zM7 11l4-7c1.5 0 2.5 1 2.5 2.5V10h5a2 2 0 012 2.3l-1.2 6A2 2 0 0117.3 20H7",
  down: "M17 13V4h3v9zM17 13l-4 7c-1.5 0-2.5-1-2.5-2.5V14h-5a2 2 0 01-2-2.3l1.2-6A2 2 0 016.7 4H17",
  sun: "M12 4V2M12 22v-2M4 12H2M22 12h-2M5.6 5.6L4.2 4.2M19.8 19.8l-1.4-1.4M5.6 18.4l-1.4 1.4M19.8 4.2l-1.4 1.4M16 12a4 4 0 11-8 0 4 4 0 018 0z",
  moon: "M20 14.5A8 8 0 019.5 4a8 8 0 1010.5 10.5z",
  chat: "M4 5h16v11H8l-4 4z",
  external: "M14 4h6v6M20 4l-9 9M18 14v5H5V6h5",
} as const;

export function Icon({ name, className = "size-5" }: { name: keyof typeof paths; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      <path d={paths[name]} />
    </svg>
  );
}

export function IconButton({
  label,
  icon,
  className = "",
  ...rest
}: {
  label: string;
  icon: keyof typeof paths;
  ref?: Ref<HTMLButtonElement>;
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={`inline-flex size-(--spacing-touch) shrink-0 items-center justify-center rounded-control text-muted transition-colors hover:bg-accent-soft hover:text-text focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-40 ${className}`}
      {...rest}
    >
      <Icon name={icon} />
    </button>
  );
}

export function Badge({ children, tone = "accent" }: { children: ReactNode; tone?: "accent" | "muted" }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-caption font-medium ${tone === "accent" ? "bg-accent-soft text-text" : "border border-border text-muted"}`}
    >
      {children}
    </span>
  );
}

export function Skeleton({ className = "" }: { className?: string }) {
  return <div aria-hidden="true" className={`animate-pulse rounded-control bg-border ${className}`} />;
}

export function useMediaQuery(query: string): boolean {
  const get = () => typeof window !== "undefined" && window.matchMedia?.(query).matches === true;
  const [matches, setMatches] = useState(get);
  useEffect(() => {
    const mq = window.matchMedia?.(query);
    if (!mq) return;
    const on = () => setMatches(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [query]);
  return matches;
}
