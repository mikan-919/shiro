import { forwardRef, useCallback, useImperativeHandle, useLayoutEffect, useRef, useState } from "react";
import { EFFORTS, MODELS } from "../shared";
import type { Settings } from "./sync";
import { Icon, IconButton, usePopover } from "./ui";
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
export function SettingsPicker({ settings, jev, auto, onChange }: { settings: Settings; jev: boolean; auto: boolean; onChange: (patch: Partial<Settings>) => void }) {
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
        {auto && <span className="picker-auto" title="コマンドの自動承認が有効です"><Icon name="shield" size={14} /></span>}
        <Icon name="tune" size={16} />
        <span className="picker-model">{MODELS.find((m) => m.id === settings.model)?.name ?? settings.model}</span>
        <span className="picker-effort">{EFFORTS[effortIndex]?.name}</span>
        <Icon name="chevron" size={14} />
      </button>
      {pop.mounted && (
        <div className={`popover picker-pop ${place.up ? "up" : "down"} ${pop.leaving ? "leaving" : ""}`} style={{ ...pop.style, maxHeight: place.max }} role="dialog" aria-label="モデルの選択">
          <div role="radiogroup" aria-label="モデル">
            {MODELS.map((m) => (
              <button type="button" role="radio" aria-checked={m.id === settings.model} key={m.id} className="pop-item" onClick={() => onChange({ model: m.id })}>
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
        </div>
      )}
    </div>
  );
}

export type ComposerHandle = { addFiles: (files: File[]) => void; focus: () => void };

export const Composer = forwardRef<ComposerHandle, {
  value: string; onChange: (v: string) => void; running: boolean; disabled: boolean;
  onSend: (text: string, images: string[]) => Promise<boolean>; onStop: () => void; placeholder: string;
}>(function Composer({ value, onChange, running, disabled, onSend, onStop, placeholder }, handle) {
  const [images, setImages] = useState<string[]>([]);
  const ta = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const addFiles = useCallback(async (files: File[]) => {
    const urls = await Promise.all(files.slice(0, MAX_IMAGES).map(toDataUrl));
    setImages((cur) => [...cur, ...urls].slice(0, MAX_IMAGES));
  }, []);
  useImperativeHandle(handle, () => ({ addFiles, focus: () => ta.current?.focus() }), [addFiles]);

  useLayoutEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);

  const canSend = !disabled && !running && (value.trim() !== "" || images.length > 0);
  const submit = async () => {
    if (!canSend) return;
    const [t, im] = [value, images];
    onChange("");
    setImages([]);
    if (!(await onSend(t, im))) (onChange(t), setImages(im));
  };

  return (
    <form
      className={`composer ${disabled ? "is-disabled" : ""}`}
      onSubmit={(e) => (e.preventDefault(), submit())}
      onClick={(e) => e.target === e.currentTarget && ta.current?.focus()}
    >
      {images.length > 0 && (
        <div className="attachments">
          {images.map((src, i) => (
            <div className="attach" key={i}>
              <img src={src} alt="" />
              <button type="button" aria-label="画像を外す" onClick={() => setImages(images.filter((_, j) => j !== i))}>
                <Icon name="x" size={12} />
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="composer-row">
        <IconButton icon="plus" label="画像を添付" disabled={disabled} onClick={() => fileInput.current?.click()} />
        <input ref={fileInput} type="file" accept="image/*" multiple hidden onChange={(e) => (addFiles(imageFiles(e.target.files)), (e.target.value = ""))} />
        <textarea
          ref={ta}
          rows={1}
          value={value}
          placeholder={placeholder}
          disabled={disabled}
          aria-label="メッセージ"
          onChange={(e) => onChange(e.target.value)}
          onPaste={(e) => {
            const files = imageFiles(e.clipboardData.files);
            if (files.length) (e.preventDefault(), addFiles(files));
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) (e.preventDefault(), submit());
            if (e.key === "Escape" && running) onStop();
          }}
        />
        {running ? (
          <button type="button" key="stop" className="send stop" onClick={onStop} aria-label="生成を停止" title="生成を停止（Esc）">
            <Icon name="stop" />
          </button>
        ) : (
          <button type="submit" key="send" className="send" disabled={!canSend} aria-label="送信" title="送信（Enter）">
            <Icon name="up" />
          </button>
        )}
      </div>
    </form>
  );
});
