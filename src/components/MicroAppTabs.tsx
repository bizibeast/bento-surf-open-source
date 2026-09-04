import { useId, type ComponentType } from "react";
import { motion, useReducedMotion } from "motion/react";
import { MobileTabSelect } from "@/components/MobileTabSelect";
import { motionTokens } from "@/lib/motion";

export type MicroAppTab<T extends string> = {
  id: T;
  label: string;
  icon: ComponentType<{ className?: string }>;
  count?: number;
};

export function MicroAppTabs<T extends string>({
  tabs,
  value,
  onChange,
  className = "",
  ariaLabel = "Page section",
}: {
  tabs: readonly MicroAppTab<T>[];
  value: T;
  onChange: (value: T) => void;
  className?: string;
  ariaLabel?: string;
}) {
  const indicatorId = useId();
  const reduceMotion = useReducedMotion();

  return (
    <>
      <MobileTabSelect
        value={value}
        options={tabs.map((tab) => ({
          value: tab.id,
          label: tab.label,
          count: tab.count,
        }))}
        onChange={onChange}
        ariaLabel={ariaLabel}
        className={className}
        variant="product"
      />
      <nav
        aria-label="Page sections"
        className={`hidden gap-1 overflow-x-auto rounded-[18px] border border-black/[0.06] bg-white p-1.5 shadow-sm sm:flex ${className}`}
      >
        {tabs.map((tab) => {
          const Icon = tab.icon;
          const selected = value === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              data-micro-app-tab
              role="tab"
              aria-selected={selected}
              onClick={() => onChange(tab.id)}
              className={`relative isolate inline-flex min-w-max flex-1 items-center justify-center gap-2 overflow-hidden rounded-xl px-4 py-2.5 text-sm font-medium transition-colors duration-300 ${
                selected ? "text-white" : "text-[#17213a]/55 hover:bg-[#f2f5fb]"
              }`}
            >
              {selected && (
                <motion.span
                  layoutId={`${indicatorId}-active-tab`}
                  className="absolute inset-0 -z-10 rounded-[inherit] bg-[#17213a]"
                  transition={
                    reduceMotion
                      ? { duration: 0 }
                      : { duration: motionTokens.duration.normal, ease: motionTokens.easing.smooth }
                  }
                />
              )}
              <Icon className="relative size-4" />
              <span className="relative">{tab.label}</span>
              {typeof tab.count === "number" && (
                <span
                  className={`relative rounded-lg px-2 py-0.5 text-[10px] tabular-nums transition-colors duration-300 ${
                    selected ? "bg-white/15 text-white" : "bg-[#f2f5fb] text-[#17213a]/55"
                  }`}
                >
                  {tab.count}
                </span>
              )}
            </button>
          );
        })}
      </nav>
    </>
  );
}
