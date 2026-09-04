import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

const INTERACTIVE =
  'button, a[href], [role="button"], [role="link"], [data-hover-guide], input[type="button"], input[type="submit"], input[type="reset"]';

type Guide = {
  text: string;
  left: number;
  top: number;
  below: boolean;
};

function guideText(element: HTMLElement) {
  const text =
    element.dataset.hoverGuide ||
    element.getAttribute("aria-label") ||
    element.getAttribute("title") ||
    (element instanceof HTMLInputElement ? element.value : element.textContent) ||
    "";
  const concise = text.replace(/\s+/g, " ").trim();
  return concise.length > 96 ? `${concise.slice(0, 93)}…` : concise;
}

function interactiveFrom(target: EventTarget | null) {
  return target instanceof Element ? (target.closest(INTERACTIVE) as HTMLElement | null) : null;
}

function positionGuide(target: HTMLElement, text: string): Guide {
  const rect = target.getBoundingClientRect();
  const below = rect.top < 56;
  const margin = Math.min(132, window.innerWidth / 2);
  return {
    text,
    left: Math.max(margin, Math.min(window.innerWidth - margin, rect.left + rect.width / 2)),
    top: below ? rect.bottom + 8 : rect.top - 8,
    below,
  };
}

export function HoverGuide({ delay = 900 }: { delay?: number }) {
  const [guide, setGuide] = useState<Guide | null>(null);
  const timer = useRef<number | null>(null);
  const target = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const clear = () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = null;
      target.current = null;
      setGuide(null);
    };
    const schedule = (next: HTMLElement | null) => {
      if (!next || next.closest("[data-hover-guide-off]")) return clear();
      const text = guideText(next);
      if (!text || next === target.current) return;
      clear();
      target.current = next;
      timer.current = window.setTimeout(() => {
        if (next.isConnected) setGuide(positionGuide(next, text));
      }, delay);
    };
    const onPointerOver = (event: PointerEvent) => {
      if (event.pointerType === "mouse") schedule(interactiveFrom(event.target));
    };
    const onPointerOut = (event: PointerEvent) => {
      if (
        interactiveFrom(event.target) !== interactiveFrom(event.relatedTarget) &&
        interactiveFrom(event.target) === target.current
      )
        clear();
    };
    const onFocusIn = (event: FocusEvent) => schedule(interactiveFrom(event.target));
    const onFocusOut = (event: FocusEvent) => {
      if (interactiveFrom(event.target) === target.current) clear();
    };

    document.addEventListener("pointerover", onPointerOver);
    document.addEventListener("pointerout", onPointerOut);
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("focusout", onFocusOut);
    document.addEventListener("click", clear);
    window.addEventListener("scroll", clear, true);
    window.addEventListener("resize", clear);
    return () => {
      clear();
      document.removeEventListener("pointerover", onPointerOver);
      document.removeEventListener("pointerout", onPointerOut);
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("focusout", onFocusOut);
      document.removeEventListener("click", clear);
      window.removeEventListener("scroll", clear, true);
      window.removeEventListener("resize", clear);
    };
  }, [delay]);

  if (!guide) return null;
  return createPortal(
    <div
      role="tooltip"
      className="pointer-events-none fixed z-[100] max-w-64 rounded-lg bg-[#17213a] px-2.5 py-1.5 text-center text-[11px] font-medium leading-4 text-white shadow-lg transition-opacity duration-150 motion-reduce:transition-none"
      style={{
        left: guide.left,
        top: guide.top,
        transform: `translate(-50%, ${guide.below ? "0" : "-100%"})`,
      }}
    >
      {guide.text}
    </div>,
    document.body,
  );
}
