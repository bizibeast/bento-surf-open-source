export type ProductBuilderStepId = "basics" | "pricing" | "details" | "page";

const STEPS = [
  { id: "basics", label: "Basics", title: "Make the offer clear" },
  { id: "pricing", label: "Pricing", title: "Choose how people pay" },
  { id: "details", label: "Details", title: "Set up the experience" },
  { id: "page", label: "Finish", title: "Finish the call to action" },
] as const;

export function productBuilderSteps(paid: boolean) {
  return paid ? [...STEPS] : STEPS.filter((step) => step.id !== "pricing");
}

export function clampProductBuilderStep(step: number, count: number) {
  return Math.max(0, Math.min(Math.max(0, count - 1), step));
}
