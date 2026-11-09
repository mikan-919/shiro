import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

export const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Reads an easing token from base.css so JS-driven motion (WAAPI) uses the same curves as CSS. */
export const cssEase = (name: "--ease-out" | "--ease-in-out") =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim() || "ease-out";

/**
 * Keeps the last non-null value around for `ms` after it becomes null, so whatever shows it can play
 * an exit. `leaving` is true during that time.
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
  return { value: present || mounted ? last.current : null, leaving: !present && mounted };
}

/**
 * Keeps a scroll container pinned to its bottom while its content grows. Instead of jumping, it glides with
 * frame-rate independent linear interpolation: each frame closes 1 - e^(-dt/tau) of the remaining distance,
 * reading the latest target every frame, so content arriving mid-glide just extends it.
 * A wheel or touch scroll by the user stops the glide; scrolling back near the bottom pins it again.
 * Changing `resetKey` (a different conversation) lands on the bottom at once.
 */
export function useFollowBottom<T extends HTMLElement>({ tau, near, resetKey }: { tau: number; near: number; resetKey?: unknown }) {
  const ref = useRef<T>(null);
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
    if (reducedMotion()) return void (el.scrollTop = el.scrollHeight);
    pos.current = el.scrollTop;
    let last = performance.now();
    const step = (now: number) => {
      const target = el.scrollHeight - el.clientHeight;
      pos.current += (target - pos.current) * (1 - Math.exp(-(now - last) / tau));
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

  useLayoutEffect(() => {
    stop();
    stick.current = true;
    setAway(false);
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [resetKey, stop]);
  useEffect(() => stop, [stop]);
  useEffect(() => {
    const content = ref.current?.firstElementChild;
    if (!content) return;
    const ro = new ResizeObserver(() => stick.current && glide());
    ro.observe(content);
    return () => ro.disconnect();
  }, [glide, resetKey]);

  const onScroll = () => {
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
  return { ref, away, onScroll, onUserScroll: stop, toBottom };
}
