import { forwardRef, useCallback, useImperativeHandle, useLayoutEffect, useRef, useState } from "react";
import { EFFORTS, MODELS } from "../shared";
import type { Settings } from "./sync";
import { Icon, IconButton, usePopover } from "./ui";
import { cssEase, reducedMotion, useFlip } from "./motion";
import "./composer.css";

const MAX_IMAGES = 8;

export const imageFiles = (list: FileList | File[] | null | undefined) => [...(list ?? [])].filter((f) => f.type.startsWith("image/"));

/** Shrinks pasted or dropped images so a screenshot does not become a multi-megabyte request. */
async function toDataUrl(file: File): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const scale = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement("canvas");
    c.width = Math.round(img.naturalWidth * scale);
    c.height = Math.round(img.naturalHeight * scale);
    c.getContext("2d")!.drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL("image/jpeg", 0.86);
  } finally {
    URL.revokeObjectURL(url);
  }
}

function clipBox(el: HTMLElement): { top: number; bottom: number } {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const o = getComputedStyle(p).overflowY;
    if (o === "auto" || o === "scroll" || o === "hidden") return p.getBoundingClientRect();
  }
  return { top: 0, bottom: innerHeight };
}

/** `auto`: commands are being auto-approved (Jev available and the setting on). */
export function SettingsPicker({ settings, jev, auto, full, onChange }: { settings: Settings; jev: boolean; auto: boolean; full: boolean; onChange: (patch: Partial<Settings>) => void }) {
  const pop = usePopover();
  const [place, setPlace] = useState({ up: true, max: 480 });
  const effortIndex = Math.max(0, EFFORTS.findIndex((e) => e.id === settings.effort));
  const toggle = (e: React.MouseEvent<HTMLButtonElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const box = clipBox(e.currentTarget);
    const above = r.top - box.top, below = box.bottom - r.bottom;
    setPlace({ up: above >= below, max: Math.max(above, below) - 16 });
    pop.setOpen(!pop.open);
  };
  return (
    <div className="picker" ref={pop.ref}>
      <button type="button" className="picker-btn" onClick={toggle} aria-expanded={pop.open} aria-haspopup="dialog">
        {full ? <span className="picker-full" title="Full Access: すべてのコマンドを確認せずに実行します"><Icon name="alert" size={14} /></span>
          : auto && <span className="picker-auto" title="コマンドの自動承認が有効です"><Icon name="shield" size={14} /></span>}
        <Icon name="tune" size={16} />
        <span className="picker-model">{MODELS.find((m) => m.id === settings.model)?.name ?? settings.model}</span>
        <span className="picker-effort">{EFFORTS[effortIndex]?.name}</span>
        <Icon name="chevron" size={14} />
      </button>
      {pop.mounted && (
        <div className={`popover picker-pop ${place.up ? "up" : "down"} ${pop.leaving ? "leaving" : ""}`} style={{ ...pop.style, maxHeight: place.max }} role="dialog" aria-label="モデルの選択">
          <div role="radiogroup" aria-label="モデル">
            {MODELS.map((m) => (
              <button type="button" role="radio" aria-checked={m.id === settings.model} key={m.id} className="pop-item swap" onClick={() => onChange({ model: m.id })}>
                <span>{m.name}</span>
                {m.id === settings.model && <Icon name="check" size={16} />}
              </button>
            ))}
          </div>
          <div className="pop-sep" />
          <p className="pop-label">考える深さ</p>
          <div className="segmented seg" role="radiogroup" aria-label="考える深さ" style={{ "--n": EFFORTS.length, "--i": effortIndex } as React.CSSProperties}>
            <span className="seg-thumb" aria-hidden="true" />
            {EFFORTS.map((e) => (
              <button type="button" role="radio" aria-checked={e.id === settings.effort} key={e.id} className={e.id === settings.effort ? "on" : ""} onClick={() => onChange({ effort: e.id })}>
                {e.name}
              </button>
            ))}
          </div>
          <div className="pop-sep" />
          <label className={`toggle-row ${jev ? "" : "is-off"}`}>
            <span className="toggle-text">
              <span>コマンドの自動承認</span>
              <span className="toggle-help">
                {jev ? "TypeSafe の Jev が安全と判定したコマンドは、確認せずに実行します" : "TYPESAFE_API_KEY を設定すると使えます"}
              </span>
            </span>
            <input type="checkbox" role="switch" className="switch" checked={auto} disabled={!jev} onChange={(e) => onChange({ autoApprove: e.target.checked })} />
          </label>
          <label className="toggle-row">
            <span className="toggle-text">
              <span>Full Access</span>
              <span className="toggle-help">すべてのコマンドとファイル編集を、確認せずに実行します</span>
            </span>
            <input type="checkbox" role="switch" className="switch" checked={full} onChange={(e) => onChange({ fullAccess: e.target.checked })} />
          </label>
        </div>
      )}
    </div>
  );
}

// ponytail: an image's length and tail stand for it; give attachments ids if two different images ever collide.
const tag = (src: string) => `${src.length}:${src.slice(-32)}`;

export type ComposerHandle = { addFiles: (files: File[]) => void; focus: () => void };

export const Composer = forwardRef<ComposerHandle, {
  value: string; onChange: (v: string) => void; running: boolean; disabled: boolean;
  onSend: (text: string, images: string[]) => Promise<boolean>; onStop: () => void; placeholder: string;
}>(function Composer({ value, onChange, running, disabled, onSend, onStop, placeholder }, handle) {
  const [images, setImages] = useState<string[]>([]);
  const [sending, setSending] = useState(false);
  const submitting = useRef(false);
  const ta = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const addFiles = useCallback(async (files: File[]) => {
    const urls = await Promise.all(files.slice(0, MAX_IMAGES).map(toDataUrl));
    setImages((cur) => [...new Set([...cur, ...urls])].slice(0, MAX_IMAGES));
  }, []);
  useImperativeHandle(handle, () => ({ addFiles, focus: () => ta.current?.focus() }), [addFiles]);

  // The box takes the height of its text, and grows or shrinks to it rather than jumping a line at a time.
  useLayoutEffect(() => {
    const el = ta.current;
    if (!el) return;
    const was = el.offsetHeight;
    // A resize still in flight would be measured instead of the text; the next one starts from where it had got to.
    for (const a of el.getAnimations()) a.cancel();
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
    const now = el.offsetHeight;
    if (was && was !== now && !reducedMotion())
      el.animate([{ height: `${was}px`, overflow: "hidden" }, { height: `${now}px`, overflow: "hidden" }], { duration: 160, easing: cssEase("--ease-out") });
  }, [value]);
  // Taking an image off slides the others into its place.
  const tray = useFlip<HTMLDivElement>([images]);

  const canSend = !disabled && !sending && (value.trim() !== "" || images.length > 0);
  const submit = async () => {
    if (!canSend || submitting.current) return;
    submitting.current = true;
    setSending(true);
    try {
      if (await onSend(value, images)) {
        onChange("");
        setImages([]);
      }
    } finally {
      submitting.current = false;
      setSending(false);
      ta.current?.focus();
    }
  };

  return (
    <form
      className={`composer ${disabled ? "is-disabled" : ""}`}
      onSubmit={(e) => (e.preventDefault(), submit())}
      onClick={(e) => e.target === e.currentTarget && ta.current?.focus()}
    >
      {images.length > 0 && (
        <div className="attachments" ref={tray}>
          {images.map((src, i) => (
            <div className="attach" key={tag(src)} data-flip={tag(src)}>
              <img src={src} alt="" />
              <button type="button" aria-label="画像を外す" disabled={sending} onClick={() => setImages(images.filter((_, j) => j !== i))}>
                <Icon name="x" size={12} />
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="composer-row">
        <IconButton icon="plus" label="画像を添付" disabled={disabled || sending} onClick={() => fileInput.current?.click()} />
        <input ref={fileInput} type="file" accept="image/*" multiple hidden onChange={(e) => (addFiles(imageFiles(e.target.files)), (e.target.value = ""))} />
        <textarea
          ref={ta}
          rows={1}
          value={value}
          placeholder={placeholder}
          readOnly={sending}
          disabled={disabled}
          aria-label="メッセージ"
          onChange={(e) => onChange(e.target.value)}
          onPaste={(e) => {
            const files = imageFiles(e.clipboardData.files);
            if (files.length) {
              e.preventDefault();
              if (!sending) addFiles(files);
            }
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) (e.preventDefault(), submit());
            if (e.key === "Escape" && running) onStop();
          }}
        />
        {running && (
          <button type="button" key="stop" className="send stop" onClick={onStop} aria-label="生成を停止" title="生成を停止（Esc）">
            <Icon name="stop" />
          </button>
        )}
        <button type="submit" key="send" className="send" disabled={!canSend} aria-label="送信" title="送信（Enter）">
          <Icon name="up" />
        </button>
      </div>
    </form>
  );
});
