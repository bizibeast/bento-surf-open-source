import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { BentoBrand } from "@/components/BentoBrand";
import { getInstancePublicConfig } from "@/lib/instance-public-config";

export function PublicAppChrome({ children }: { children: ReactNode }) {
  const { privacyUrl, termsUrl, sourceUrl } = getInstancePublicConfig(import.meta.env);
  return (
    <>
      <header className="border-b border-[#17213a]/10 bg-white px-4 text-[#17213a] sm:px-6">
        <div className="mx-auto flex min-h-16 max-w-7xl items-center gap-5">
          <BentoBrand iconClassName="size-8" textClassName="text-sm sm:text-base" />
          <nav
            aria-label="Public application"
            className="ml-auto flex items-center gap-3 text-sm font-medium sm:gap-5"
          >
            <Link to="/explore" search={{ q: "", page: 1 }} className="hover:text-[#3478f6]">
              Explore
            </Link>
            <Link to="/login" search={{ redirect: "/link" }} className="hover:text-[#3478f6]">
              Log in
            </Link>
            <Link
              to="/signup"
              className="rounded-full bg-[#17213a] px-4 py-2 text-white hover:bg-[#3478f6]"
            >
              Sign up
            </Link>
          </nav>
        </div>
      </header>

      {children}

      <footer className="border-t border-[#17213a]/10 bg-white px-4 py-6 text-[#17213a] sm:px-6">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-5">
          <BentoBrand iconClassName="size-7" textClassName="text-sm" />
          <nav aria-label="Legal" className="flex gap-5 text-sm text-[#17213a]/65">
            {privacyUrl ? (
              <a href={privacyUrl} className="hover:text-[#17213a]">
                Privacy
              </a>
            ) : (
              <Link to="/privacy" className="hover:text-[#17213a]">
                Privacy
              </Link>
            )}
            {termsUrl ? (
              <a href={termsUrl} className="hover:text-[#17213a]">
                Terms
              </a>
            ) : (
              <Link to="/terms" className="hover:text-[#17213a]">
                Terms
              </Link>
            )}
            {sourceUrl && (
              <a href={sourceUrl} className="hover:text-[#17213a]" rel="noreferrer">
                Source
              </a>
            )}
          </nav>
        </div>
      </footer>
    </>
  );
}
