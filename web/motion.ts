import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from "react";

export const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Reads an easing token from base.css so JS-driven motion (WAAPI) uses the same curves as CSS. */
export const cssEase = (name: "--ease-out" | "--ease-in-out" | "--ease-drawer") =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim() || "ease-out";

/** One frame of frame-rate independent linear interpolation: closes 1 - e^(-dt/tau) of the distance from `from` to `to`. */
export const approach = (from: number, to: number, dt: number, tau: number) => from + (to - from) * (1 - Math.exp(-dt / tau));

/**
 * A number that glides to `target` by lerp instead of jumping, for counts that tick. It first renders the target,
 * so markup without effects is right; with `from`, it then starts there and counts in when it mounts.
 */
export function useLerp(target: number, tau = 90, from = target) {
  const [shown, setShown] = useState(target);
  const at = useRef(from);
  useLayoutEffect(() => {
    if (reducedMotion()) return void setShown((at.current = target));
    setShown(at.current);
    let last = performance.now();
    let raf = requestAnimationFrame(function step(now) {
      at.current = approach(at.current, target, now - last, tau);
      last = now;
      if (Math.abs(target - at.current) < 0.5) at.current = target;
      setShown(at.current);
      if (at.current !== target) raf = requestAnimationFrame(step);
    });
    return () => cancelAnimationFrame(raf);
  }, [target, tau]);
  return shown;
}

/** Where an element is laid out inside `root`. Offsets, not client rects: a transform in flight or a scroll does not move them. */
function place(el: HTMLElement, root: HTMLElement) {
  let x = 0, y = 0;
  for (let e: HTMLElement | null = el; e; e = e.offsetParent as HTMLElement | null) (x += e.offsetLeft), (y += e.offsetTop);
  for (let e: HTMLElement | null = root; e; e = e.offsetParent as HTMLElement | null) (x -= e.offsetLeft), (y -= e.offsetTop);
  return { x, y };
}

/**
 * FLIP: when `deps` change, each [data-flip] element under the returned ref slides from where it was laid out
 * before. The slide is added to whatever is already moving the element, so a change mid-slide carries on from
 * there. With `enter`, elements that were not there before fade in. The first layout does not animate.
 */
export function useFlip<T extends HTMLElement>(deps: unknown[], enter = false) {
  const ref = useRef<T>(null);
  const seen = useRef(new Map<string, { x: number; y: number }>());
  useLayoutEffect(() => {
    const root = ref.current;
    if (!root) return;
    const next = new Map<string, { x: number; y: number }>();
    const animate = seen.current.size > 0 && !reducedMotion();
    for (const el of root.querySelectorAll<HTMLElement>("[data-flip]")) {
      const at = place(el, root);
      const was = seen.current.get(el.dataset.flip!);
      next.set(el.dataset.flip!, at);
      if (!animate) continue;
      if (!was) {
        if (enter) el.animate([{ opacity: 0, transform: "translateY(-6px)" }, { opacity: 1, transform: "none" }], { duration: 220, easing: cssEase("--ease-out") });
      } else if (Math.abs(was.x - at.x) > 1 || Math.abs(was.y - at.y) > 1)
        el.animate([{ transform: `translate(${was.x - at.x}px, ${was.y - at.y}px)` }, { transform: "none" }], { duration: 280, easing: cssEase("--ease-in-out"), composite: "add" });
    }
    seen.current = next;
  }, deps);
  return ref;
}

/**
 * Shared-element FLIP for a highlight that one element of a group has at a time (the open conversation, the chosen
 * filter): when another element under `root` comes to match `selector`, the highlight flies there from the last
 * one, stretching to the new size. The highlight has to be drawn by the element's ::before.
 */
export function usePill(root: RefObject<HTMLElement | null>, selector: string, deps: unknown[]) {
  const last = useRef<{ id: unknown; x: number; y: number; w: number; h: number }>(undefined);
  useLayoutEffect(() => {
    const el = root.current?.querySelector<HTMLElement>(selector);
    const was = last.current;
    const now = (last.current = el ? { id: el.dataset.flip ?? el, ...place(el, root.current!), w: el.offsetWidth, h: el.offsetHeight } : undefined);
    if (!el || !now || !was || was.id === now.id || reducedMotion()) return;
    const sx = was.w / now.w, sy = was.h / now.h;
    // Scaling would squash the corners, so the radius starts out divided by the scale.
    const r = Math.min(parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0, now.h / 2);
    el.animate(
      [
        { transformOrigin: "0 0", transform: `translate(${was.x - now.x}px, ${was.y - now.y}px) scale(${sx}, ${sy})`, borderRadius: `${r / sx}px / ${r / sy}px` },
        { transformOrigin: "0 0", transform: "none", borderRadius: `${r}px` },
      ],
      { duration: 260, easing: cssEase("--ease-out"), pseudoElement: "::before" },
    );
  }, deps);
}

/**
 * Keeps the last non-null value around for `ms` after it becomes null, so whatever shows it can play
 * an exit. `leaving` is true during that time. `style` hands the duration to CSS as --exit, so the exit
 * transition and the unmount use the same number.
 */
export function useLinger<T>(value: T | null, ms: number) {
  const last = useRef(value);
  if (value !== null) last.current = value;
  const [mounted, setMounted] = useState(value !== null);
  const present = value !== null;
  useEffect(() => {
    if (present) return void setMounted(true);
    if (reducedMotion()) return void setMounted(false);
    const t = setTimeout(() => setMounted(false), ms);
    return () => clearTimeout(t);
  }, [present, ms]);
  return { value: present || mounted ? last.current : null, leaving: !present && mounted, style: { "--exit": `${ms}ms` } as CSSProperties };
}

/**
 * Keeps a scroll container pinned to its bottom while its content grows. Instead of jumping, it glides by lerp
 * (`approach`), reading the latest target every frame, so content arriving mid-glide just extends it.
 * A wheel or touch scroll by the user stops the glide; scrolling back near the bottom pins it again.
 * Spread `scroller` on the scrolling element and put `content` on the element whose growth it follows.
 * `onScroll` runs on every scroll, the glide's own frames included.
 */
export function useFollowBottom<S extends HTMLElement, C extends HTMLElement>({ tau, near, onScroll: also }: { tau: number; near: number; onScroll?: () => void }) {
  const ref = useRef<S>(null);
  const content = useRef<C>(null);
  const stick = useRef(true);
  const pos = useRef(0);
  const raf = useRef(0);
  const [away, setAway] = useState(false);

  const stop = useCallback(() => {
    cancelAnimationFrame(raf.current);
    raf.current = 0;
  }, []);

  const glide = useCallback(() => {
    const el = ref.current;
    if (!el || raf.current) return;
    // Even the reduced-motion jump waits for a frame: glide runs from a ResizeObserver callback, and layout
    // written there makes Chrome report "ResizeObserver loop completed with undelivered notifications".
    const instant = reducedMotion();
    pos.current = el.scrollTop;
    let last = performance.now();
    const step = (now: number) => {
      const target = el.scrollHeight - el.clientHeight;
      pos.current = instant ? target : approach(pos.current, target, now - last, tau);
      last = now;
      if (Math.abs(target - pos.current) < 0.5) {
        el.scrollTop = target;
        raf.current = 0;
        return;
      }
      el.scrollTop = pos.current;
      raf.current = requestAnimationFrame(step);
    };
    raf.current = requestAnimationFrame(step);
  }, [tau]);

  // A new scroller starts at its end; gliding there from the top would be noise.
  useLayoutEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, []);
  useEffect(() => stop, [stop]);
  useEffect(() => {
    const el = content.current;
    if (!el) return;
    const ro = new ResizeObserver(() => stick.current && glide());
    ro.observe(el);
    return () => ro.disconnect();
  }, [glide]);

  const onScroll = () => {
    also?.();
    const el = ref.current;
    if (!el || raf.current) return; // our own frames
    const isNear = el.scrollHeight - el.scrollTop - el.clientHeight < near;
    stick.current = isNear;
    setAway(!isNear);
  };
  const toBottom = () => {
    stick.current = true;
    setAway(false);
    glide();
  };
  return { scroller: { ref, onScroll, onWheel: stop, onTouchStart: stop }, content, away, toBottom };
}
