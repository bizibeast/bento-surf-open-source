import type { InputHTMLAttributes, ReactNode } from "react";
import { configuredPublicOrigin } from "@/lib/application-urls";
import { BentoFullLogo } from "@/components/BentoBrand";

export function AuthShell({ children }: { children: ReactNode }) {
  return (
    <main className="auth-light min-h-dvh bg-[#faf9f7] text-[#1b1b1b] selection:bg-[#1b1b1b] selection:text-white">
      <div className="mx-auto flex min-h-dvh w-full max-w-[1200px] flex-col px-4 sm:px-8">
        <header className="flex h-16 shrink-0 items-center border-b border-black/[0.07] sm:h-20">
          <AuthBrand />
        </header>

        <section className="flex flex-1 items-center justify-center py-8 sm:py-16">
          <div className="w-full max-w-[440px]">{children}</div>
        </section>

        <footer className="flex min-h-16 flex-wrap items-center justify-center gap-x-4 gap-y-2 border-t border-black/[0.07] py-4 text-center text-xs text-black/40">
          <span className="inline-flex items-center gap-2">
            <BentoFullLogo className="h-5 w-auto" />
            <span>· Your creator storefront</span>
          </span>
          <a href="/privacy" className="hover:text-black/70">
            Privacy
          </a>
          <a href="/terms" className="hover:text-black/70">
            Terms
          </a>
        </footer>
      </div>
    </main>
  );
}

export function AuthBrand() {
  return (
    <a
      href={configuredPublicOrigin(import.meta.env.VITE_PUBLIC_URL)}
      aria-label="bento.surf home"
      className="transition-opacity hover:opacity-60"
    >
      <BentoFullLogo className="h-8 w-auto sm:h-9" />
    </a>
  );
}

export function AuthField({
  label,
  hint,
  error,
  trailing,
  className = "",
  ...props
}: InputHTMLAttributes<HTMLInputElement> & {
  label: string;
  hint?: string;
  error?: string | null;
  trailing?: ReactNode;
}) {
  return (
    <label className={`block ${className}`}>
      <span className="mb-2 flex items-center justify-between gap-3 text-sm font-medium">
        <span>{label}</span>
        {hint && <span className="text-xs font-normal text-black/40">{hint}</span>}
      </span>
      <span className="relative block">
        <input
          {...props}
          aria-invalid={Boolean(error)}
          className={`h-12 w-full rounded-xl border bg-white px-3.5 text-[15px] outline-none transition placeholder:text-black/30 focus:ring-2 ${
            error
              ? "border-red-500/60 focus:border-red-500 focus:ring-red-500/10"
              : "border-black/10 focus:border-black/35 focus:ring-black/[0.06]"
          } ${trailing ? "pr-14" : ""}`}
        />
        {trailing && (
          <span className="absolute inset-y-0 right-1 flex items-center">{trailing}</span>
        )}
      </span>
      {error && (
        <span className="mt-2 block text-sm text-red-600" role="alert">
          {error}
        </span>
      )}
    </label>
  );
}

export function AuthDivider() {
  return (
    <div className="my-5 flex items-center gap-3" aria-hidden="true">
      <span className="h-px flex-1 bg-black/[0.08]" />
      <span className="text-xs text-black/35">or</span>
      <span className="h-px flex-1 bg-black/[0.08]" />
    </div>
  );
}

export function GoogleIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-5" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M21.6 12.227c0-.708-.064-1.39-.182-2.045H12v3.868h5.382a4.6 4.6 0 0 1-1.995 3.018v2.51h3.232c1.89-1.741 2.981-4.305 2.981-7.351Z"
      />
      <path
        fill="#34A853"
        d="M12 22c2.7 0 4.964-.895 6.619-2.422l-3.232-2.51c-.895.6-2.04.955-3.387.955-2.604 0-4.81-1.76-5.596-4.122H3.064v2.59A9.997 9.997 0 0 0 12 22Z"
      />
      <path
        fill="#FBBC05"
        d="M6.404 13.9A6.012 6.012 0 0 1 6.09 12c0-.66.114-1.3.313-1.9V7.51H3.064A9.997 9.997 0 0 0 2 12c0 1.614.386 3.14 1.064 4.49l3.34-2.59Z"
      />
      <path
        fill="#EA4335"
        d="M12 5.977c1.47 0 2.787.505 3.823 1.496l2.867-2.867C16.96 2.99 14.695 2 12 2 8.087 2 4.71 4.245 3.064 7.51l3.34 2.59C7.191 7.738 9.395 5.977 12 5.977Z"
      />
    </svg>
  );
}
