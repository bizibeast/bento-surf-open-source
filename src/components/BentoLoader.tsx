import { BentoLoaderMark } from "@/components/BentoLoaderMark";

export function BentoLoader() {
  return (
    <div role="status" aria-live="polite" aria-label="Loading" className="grid place-items-center">
      <BentoLoaderMark />
    </div>
  );
}
