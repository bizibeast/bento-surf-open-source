import { ChevronDown } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from "@/components/ui/dropdown-menu";

/** Shares the chat list's Radix menu, including keyboard navigation and focus return. */
export function BennyModelPicker({
  value,
  options,
  disabled,
  onChange,
}: {
  value: string;
  options: { value: string; label: string; disabled?: boolean }[];
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="Benny model"
          disabled={disabled || !options.length}
          className="flex h-9 min-w-0 max-w-full items-center gap-2 rounded-xl px-3 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50"
        >
          <span className="truncate">
            {options.find((option) => option.value === value)?.label || "Choose a model"}
          </span>
          <ChevronDown className="size-4 shrink-0" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="end" sideOffset={8} className="w-64 rounded-xl p-1.5">
        <DropdownMenuRadioGroup value={value} onValueChange={onChange}>
          {options.map((option) => (
            <DropdownMenuRadioItem
              key={option.value}
              value={option.value}
              disabled={option.disabled}
              title={option.disabled ? "Temporarily unavailable" : undefined}
              className="rounded-lg py-2.5 pr-3"
            >
              {option.label}
              {option.disabled && (
                <span aria-hidden="true" className="ml-auto text-[10px]">
                  Unavailable
                </span>
              )}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
