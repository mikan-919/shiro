import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useLinger } from "./motion";

const ICONS: Record<string, ReactNode> = {
  compose: <><path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" /><path d="M18.4 2.6a2.1 2.1 0 0 1 3 3L12 15l-4 1 1-4Z" /></>,
  search: <><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></>,
  panel: <><rect x="3" y="3" width="18" height="18" rx="2.5" /><path d="M9 3v18" /></>,
  clip: <path d="m21.4 11.1-9.2 9.2a6 6 0 0 1-8.5-8.5l8.6-8.6a4 4 0 0 1 5.7 5.7l-8.6 8.6a2 2 0 0 1-2.8-2.8l8.5-8.5" />,
  up: <><path d="m5 12 7-7 7 7" /><path d="M12 19V5" /></>,
  down: <><path d="M12 5v14" /><path d="m19 12-7 7-7-7" /></>,
  stop: <rect x="7" y="7" width="10" height="10" rx="1.5" fill="currentColor" stroke="none" />,
  copy: <><rect x="8" y="8" width="13" height="13" rx="2" /><path d="M4 16V5a1 1 0 0 1 1-1h11" /></>,
  check: <path d="M20 6 9 17l-5-5" />,
  pencil: <path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />,
  retry: <><path d="M3 12a9 9 0 0 1 15-6.7L21 8" /><path d="M21 3v5h-5" /><path d="M21 12a9 9 0 0 1-15 6.7L3 16" /><path d="M3 21v-5h5" /></>,
  trash: <><path d="M3 6h18" /><path d="M8 6V4h8v2" /><path d="m19 6-1 14H6L5 6" /></>,
  dots: <><circle cx="5" cy="12" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /></>,
  chevron: <path d="m6 9 6 6 6-6" />,
  x: <><path d="M18 6 6 18" /><path d="m6 6 12 12" /></>,
  file: <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" /><path d="M14 2v6h6" /></>,
  terminal: <><path d="m4 17 6-6-6-6" /><path d="M12 19h8" /></>,
  sun: <><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2m-7.1-17.1 1.4 1.4m11.4 11.4 1.4 1.4M2 12h2m16 0h2M6.3 17.7l-1.4 1.4M19.1 4.9l-1.4 1.4" /></>,
  moon: <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />,
  monitor: <><rect x="2" y="3" width="20" height="14" rx="2" /><path d="M8 21h8M12 17v4" /></>,
  logout: <><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><path d="m16 17 5-5-5-5" /><path d="M21 12H9" /></>,
  ring: <circle cx="12" cy="12" r="7" strokeDasharray="2.2 2.6" />,
  shield: <><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" /><path d="m9 12 2 2 4-4" /></>,
  alert: <><circle cx="12" cy="12" r="9" /><path d="M12 8v4.5M12 16h.01" /></>,
  folder: <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.7-.9L9.6 3.9A2 2 0 0 0 7.9 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />,
};

export function Icon({ name, size = 18 }: { name: string; size?: number }) {
  return (
    <svg className="icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {ICONS[name] ?? ICONS.terminal}
    </svg>
  );
}

export function IconButton({ icon, label, onClick, className = "", disabled, size }: { icon: string; label: string; onClick?: () => void; className?: string; disabled?: boolean; size?: number }) {
  return (
    <button type="button" className={`icon-btn ${className}`} onClick={onClick} aria-label={label} title={label} disabled={disabled}>
      <Icon name={icon} size={size} />
    </button>
  );
}

export function CopyButton({ get, label = "コピー" }: { get: () => string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <IconButton
      icon={done ? "check" : "copy"}
      label={done ? "コピーしました" : label}
      size={16}
      onClick={async () => {
        await navigator.clipboard.writeText(get());
        setDone(true);
        setTimeout(() => setDone(false), 1500);
      }}
    />
  );
}

/** A panel that opens and closes in place, animating its height (grid rows 0fr ↔ 1fr) both ways. */
export function Collapse({ open, children }: { open: boolean; children: ReactNode }) {
  const shown = useLinger(open ? { children } : null, 220);
  if (!shown.value) return null;
  return (
    <div className={`collapse ${open ? "open" : ""}`}>
      <div className="collapse-inner">{shown.value.children}</div>
    </div>
  );
}

/**
 * A popover's open state: closes on a click outside `ref` or on Escape, and stays mounted briefly
 * after closing so it can play its exit (`leaving`).
 */
export function usePopover() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && close();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, close]);
  const presence = useLinger(open || null, 120);
  return { open, setOpen, ref, mounted: !!presence.value, leaving: presence.leaving };
}
