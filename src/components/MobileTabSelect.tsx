import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

export type MobileTabOption<T extends string> = {
  value: T;
  label: string;
  count?: number;
};

export function MobileTabSelect<T extends string>({
  value,
  options,
  onChange,
  ariaLabel = "Choose section",
  className,
  variant = "theme",
}: {
  value: T;
  options: readonly MobileTabOption<T>[];
  onChange: (value: T) => void;
  ariaLabel?: string;
  className?: string;
  variant?: "theme" | "product";
}) {
  const product = variant === "product";
  return (
    <div className={cn("group relative sm:hidden", className)}>
      <select
        aria-label={ariaLabel}
        value={value}
        onChange={(event) => onChange(event.target.value as T)}
        className={
          product
            ? "h-12 w-full appearance-none rounded-lg border border-black/[0.06] bg-white px-4 pr-11 text-sm font-semibold text-[#17213a] shadow-sm outline-none transition focus:border-[#3478f6]/45 focus:ring-2 focus:ring-[#3478f6]/15 active:scale-[0.99]"
            : "h-12 w-full appearance-none rounded-lg border border-border bg-card px-4 pr-11 text-sm font-semibold text-foreground shadow-sm outline-none transition-[border-color,box-shadow,transform] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] focus:border-ring focus:ring-2 focus:ring-ring/30 active:scale-[0.99] motion-reduce:duration-0"
        }
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
            {typeof option.count === "number" ? ` (${option.count})` : ""}
          </option>
        ))}
      </select>
      <ChevronDown
        aria-hidden="true"
        className={cn(
          "pointer-events-none absolute right-4 top-1/2 size-4 -translate-y-1/2 transition-transform duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] group-focus-within:-translate-y-1/2 group-focus-within:rotate-180 motion-reduce:duration-0",
          product ? "text-[#17213a]/45" : "text-muted-foreground",
        )}
      />
    </div>
  );
}
