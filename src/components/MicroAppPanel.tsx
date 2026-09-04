import { type ReactNode } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { motionTokens } from "@/lib/motion";
import { micro } from "@/lib/micro-app-ui";

export function MicroAppPanel({
  children,
  className = "",
  padded = true,
}: {
  children: ReactNode;
  className?: string;
  padded?: boolean;
}) {
  return (
    <section className={`${micro.panel} ${padded ? micro.panelPad : ""} ${className}`}>
      {children}
    </section>
  );
}

export function MicroAppStatCard({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return <div className={`${micro.stat} ${className}`}>{children}</div>;
}

export function MicroAppTabMotion({
  tabKey,
  children,
  className = "mt-5",
}: {
  tabKey: string;
  children: ReactNode;
  className?: string;
}) {
  const reduceMotion = useReducedMotion();
  return (
    <AnimatePresence mode="wait" initial={false}>
      <motion.div
        key={tabKey}
        initial={reduceMotion ? false : { opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -6 }}
        transition={{
          duration: reduceMotion ? 0 : motionTokens.duration.fast,
          ease: motionTokens.easing.smooth,
        }}
        className={className}
      >
        {children}
      </motion.div>
    </AnimatePresence>
  );
}
