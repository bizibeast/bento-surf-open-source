import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { ArrowRight, Eye, EyeOff } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { captureProductEvent } from "@/lib/posthog";
import { AuthDivider, AuthField, AuthShell, GoogleIcon } from "@/components/AuthShell";
import { sanitizeLocalRedirect, trustedApplicationOrigin } from "@/lib/safe-url";
import { redirectAuthenticatedVisitor } from "@/lib/auth-entry";
import { handleWebMcpFormSubmit } from "@/lib/webmcp";

export const Route = createFileRoute("/login")({
  validateSearch: (s) => ({ redirect: sanitizeLocalRedirect(s.redirect) }),
  beforeLoad: async ({ search }) => {
    await redirectAuthenticatedVisitor(search.redirect);
  },
  head: () => ({ meta: [{ title: "Sign in | bento.surf" }] }),
  component: LoginPage,
});

function LoginPage() {
  const search = Route.useSearch();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [loading, setLoading] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

  const handleSubmit = (event: FormEvent<HTMLFormElement>) =>
    handleWebMcpFormSubmit(event, async () => {
      setAuthError(null);
      if (!email.trim() || email.trim().length > 254 || !password || password.length > 128) {
        const message = "Enter your email and password to sign in.";
        setAuthError(message);
        toast.error(message);
        return { ok: false, message: "Sign-in needs valid credentials." };
      }
      setLoading(true);
      try {
        const { error } = await supabase.auth.signInWithPassword({
          email: email.trim(),
          password,
        });
        if (error) throw error;
        captureProductEvent("login_completed", { method: "email" });
        await navigate({ to: search.redirect, replace: true });
        return { ok: true, message: "Signed in to Bento." };
      } catch (error) {
        const message = getAuthErrorMessage(error);
        setAuthError(message);
        toast.error(message);
        return {
          ok: false,
          message: "Sign-in did not complete. Review the form error and try again.",
        };
      } finally {
        setLoading(false);
      }
    });

  const handleGoogle = async () => {
    setAuthError(null);
    setGoogleLoading(true);
    const toastId = toast.loading("Opening Google sign-in…");
    try {
      captureProductEvent("login_completed", { method: "google_redirect_started" });
      const { error } = await supabase.auth.signInWithOAuth({
        provider: "google",
        options: {
          redirectTo:
            trustedApplicationOrigin(window.location.origin, import.meta.env.VITE_APP_URL) +
            search.redirect,
        },
      });
      if (error) throw error;
      // The browser redirects to Google on success; nothing runs after this.
    } catch (error) {
      const message = getAuthErrorMessage(error);
      setAuthError(message);
      toast.error(message, { id: toastId });
    } finally {
      setGoogleLoading(false);
    }
  };

  return (
    <AuthShell>
      <div className="mb-8">
        <h1 className="font-display text-4xl leading-none sm:text-5xl">Sign in</h1>
        <p className="mt-3 text-sm leading-6 text-black/50">
          Welcome back. Continue to your Bento.
        </p>
      </div>

      <button
        type="button"
        onClick={handleGoogle}
        disabled={loading || googleLoading}
        className="flex h-12 w-full items-center justify-center gap-3 rounded-xl border border-black/10 bg-white px-4 text-sm font-medium transition hover:border-black/20 hover:bg-black/[0.015] disabled:opacity-50"
      >
        <GoogleIcon />
        {googleLoading ? "Opening Google…" : "Continue with Google"}
      </button>

      <AuthDivider />

      <form
        onSubmit={handleSubmit}
        noValidate
        className="space-y-4"
        toolname="bento_prepare_sign_in"
        tooldescription="Fills the Bento email sign-in form for the user to review and submit."
      >
        <AuthField
          name="email"
          toolparamdescription="Email address for the Bento account."
          label="Email"
          type="email"
          maxLength={254}
          inputMode="email"
          autoComplete="email"
          required
          value={email}
          onChange={(event) => {
            setEmail(event.target.value);
            setAuthError(null);
          }}
          placeholder="you@example.com"
        />
        <AuthField
          name="password"
          toolparamdescription="Password for the Bento account."
          label="Password"
          type={showPw ? "text" : "password"}
          maxLength={128}
          autoComplete="current-password"
          required
          value={password}
          onChange={(event) => {
            setPassword(event.target.value);
            setAuthError(null);
          }}
          placeholder="Your password"
          trailing={
            <button
              type="button"
              onClick={() => setShowPw((value) => !value)}
              aria-label={showPw ? "Hide password" : "Show password"}
              className="flex size-10 items-center justify-center rounded-lg text-black/40 transition hover:bg-black/[0.04] hover:text-black"
            >
              {showPw ? <EyeOff className="size-4.5" /> : <Eye className="size-4.5" />}
            </button>
          }
        />

        <div className="text-right">
          <Link to="/reset-password" className="text-sm font-medium text-black hover:underline">
            Forgot password?
          </Link>
        </div>

        {authError && (
          <div
            className="rounded-xl border border-red-500/15 bg-red-50 px-4 py-3 text-sm text-red-700"
            role="alert"
          >
            {authError}
          </div>
        )}

        <button
          type="submit"
          disabled={loading || googleLoading}
          className="group flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-black px-5 text-sm font-medium text-white transition hover:bg-black/85 disabled:opacity-50"
        >
          {loading ? "Signing in…" : "Sign in"}
          {!loading && (
            <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />
          )}
        </button>
      </form>

      <p className="mt-7 text-center text-sm text-black/50">
        New to Bento?{" "}
        <Link to="/signup" className="font-medium text-black hover:underline">
          Create an account
        </Link>
      </p>
    </AuthShell>
  );
}

function getAuthErrorMessage(error: unknown) {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "object" && error && "message" in error
        ? String(error.message)
        : "";
  if (/invalid login credentials/i.test(message)) {
    return "That email and password don’t match. Check them and try again.";
  }
  if (/email not confirmed/i.test(message)) {
    return "Confirm your email first, then come back here to sign in.";
  }
  if (message) return message;
  return "Sign-in failed. Please try again.";
}

// Re-exports kept for backwards compatibility with files importing { Field } from "../login".
export function Field({
  label,
  type = "text",
  value,
  onChange,
  required,
  placeholder,
}: {
  label: string;
  type?: string;
  value: string;
  onChange: (v: string) => void;
  required?: boolean;
  placeholder?: string;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-medium text-muted-foreground">{label}</span>
      <input
        type={type}
        value={value}
        required={required}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-xl border border-input bg-background px-3.5 py-2.5 text-sm outline-none transition focus:border-foreground"
      />
    </label>
  );
}
