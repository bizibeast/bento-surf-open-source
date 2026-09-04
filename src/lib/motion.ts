export const motionTokens = {
  duration: {
    instant: 0.08,
    fast: 0.18,
    normal: 0.35,
    slow: 0.6,
    crawl: 1,
  },
  easing: {
    smooth: [0.22, 1, 0.36, 1],
    linear: [0, 0, 1, 1],
  },
  scale: {
    subtle: 0.98,
    press: 0.96,
    pop: 1.04,
  },
} as const;

export const springs = {
  snappy: { type: "spring", stiffness: 300, damping: 30 },
  gentle: { type: "spring", stiffness: 120, damping: 14 },
} as const;
