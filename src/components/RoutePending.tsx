import { BentoLoader } from "./BentoLoader";

export function RoutePending() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-[#f7f8fc] text-[#17213a]">
      <BentoLoader />
    </div>
  );
}
