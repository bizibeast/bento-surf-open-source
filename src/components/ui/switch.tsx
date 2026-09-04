import * as React from "react";
import * as SwitchPrimitives from "@radix-ui/react-switch";

import { cn } from "@/lib/utils";

const Switch = React.forwardRef<
  React.ElementRef<typeof SwitchPrimitives.Root>,
  React.ComponentPropsWithoutRef<typeof SwitchPrimitives.Root>
>(({ className, ...props }, ref) => (
  <SwitchPrimitives.Root
    className={cn(
      "peer group relative inline-flex size-11 shrink-0 cursor-pointer items-center rounded-lg border-0 bg-transparent shadow-none transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50 sm:h-5 sm:w-9",
      className,
    )}
    {...props}
    ref={ref}
  >
    <span className="pointer-events-none absolute left-1/2 top-1/2 h-5 w-9 -translate-x-1/2 -translate-y-1/2 rounded-lg bg-input shadow-sm transition-colors group-data-[state=checked]:bg-primary" />
    <SwitchPrimitives.Thumb
      className={cn(
        "pointer-events-none absolute left-1/2 top-1/2 -ml-4 -mt-2 block h-4 w-4 rounded-[5px] bg-background shadow-lg ring-0 transition-transform data-[state=checked]:translate-x-4 data-[state=unchecked]:translate-x-0",
      )}
    />
  </SwitchPrimitives.Root>
));
Switch.displayName = SwitchPrimitives.Root.displayName;

export { Switch };
