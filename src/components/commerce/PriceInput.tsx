import { useEffect, useRef, useState } from "react";

function amountToText(amount: number) {
  if (!Number.isFinite(amount) || amount <= 0) return "";
  return String(amount / 100);
}

export function PriceInput({
  amount,
  ariaLabel = "Price",
  disabled = false,
  className = "",
  onAmountChange,
}: {
  amount: number;
  ariaLabel?: string;
  disabled?: boolean;
  className?: string;
  onAmountChange: (amount: number) => void;
}) {
  const [text, setText] = useState(() => amountToText(amount));
  const focused = useRef(false);

  useEffect(() => {
    if (!focused.current) setText(amountToText(amount));
  }, [amount]);

  return (
    <input
      aria-label={ariaLabel}
      type="number"
      inputMode="decimal"
      min="0"
      step="0.01"
      disabled={disabled}
      value={disabled ? "" : text}
      placeholder="0.00"
      onFocus={() => {
        focused.current = true;
      }}
      onChange={(event) => {
        const next = event.target.value;
        setText(next);
        if (next === "") {
          onAmountChange(0);
          return;
        }
        const parsed = Number(next);
        if (Number.isFinite(parsed) && parsed >= 0) {
          onAmountChange(Math.round(parsed * 100));
        }
      }}
      onBlur={() => {
        focused.current = false;
        setText(amountToText(amount));
      }}
      className={`${className} [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none`}
    />
  );
}
