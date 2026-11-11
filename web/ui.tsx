import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useLinger } from "./motion";

import { ArrowDown, ArrowUp, Check, ChevronDown, CircleAlert, CircleDashed, Copy, Ellipsis, File, Folder, LogOut, Menu, MessageCircle, Monitor, Moon, Paperclip, PanelLeft, Pencil, Plus, RefreshCw, Search, ShieldCheck, SlidersHorizontal, Smile, Square, SquarePen, Sun, Terminal, Trash2, X, type LucideIcon } from "lucide-react";

const ICONS = {
  compose: SquarePen, search: Search, panel: PanelLeft, clip: Paperclip,
  up: ArrowUp, down: ArrowDown, stop: Square, copy: Copy, check: Check,
  pencil: Pencil, retry: RefreshCw, trash: Trash2, dots: Ellipsis,
  chevron: ChevronDown, x: X, file: File, terminal: Terminal, sun: Sun,
  moon: Moon, monitor: Monitor, logout: LogOut, ring: CircleDashed,
  shield: ShieldCheck, alert: CircleAlert, folder: Folder, smile: Smile,
  menu: Menu, chat: MessageCircle, plus: Plus, tune: SlidersHorizontal,
} satisfies Record<string, LucideIcon>;
export type IconName = keyof typeof ICONS;

export function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  const Glyph = ICONS[name];
  return <Glyph className="icon" size={size} strokeWidth={1.7} fill={name === "stop" ? "currentColor" : "none"} aria-hidden="true" />;
}

export function IconButton({ icon, label, onClick, className = "", disabled, small }: { icon: IconName; label: string; onClick?: () => void; className?: string; disabled?: boolean; small?: boolean }) {
  return (
    <button type="button" className={`icon-btn ${small ? "small" : ""} ${className}`} onClick={onClick} aria-label={label} title={label} disabled={disabled}>
      <Icon name={icon} size={small ? 16 : 18} />
    </button>
  );
}

export function CopyButton({ get, label = "コピー" }: { get: () => string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <IconButton
      icon={done ? "check" : "copy"}
      label={done ? "コピーしました" : label}
      small
      onClick={async () => {
        await navigator.clipboard.writeText(get());
        setDone(true);
        setTimeout(() => setDone(false), 1500);
      }}
    />
  );
}

export function Collapse({ open, children }: { open: boolean; children: ReactNode }) {
  const shown = useLinger(open ? { children } : null, 220);
  if (!shown.value) return null;
  return (
    <div className={`collapse ${open ? "open" : ""}`} style={shown.style}>
      <div className="collapse-inner">{shown.value.children}</div>
    </div>
  );
}

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
  return { open, setOpen, ref, mounted: !!presence.value, leaving: presence.leaving, style: presence.style };
}
