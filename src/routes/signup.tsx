import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { ArrowLeft, ArrowRight, Check, Eye, EyeOff, Mail, RotateCw } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { checkUsername } from "@/lib/profile.functions";
import { useUsernameAvailability } from "@/lib/use-username-availability";
import { normalizeUsername } from "@/lib/username";
import { storePendingUsername } from "@/lib/pending-username";
import { captureProductEvent } from "@/lib/posthog";
import { AuthDivider, AuthField, AuthShell, GoogleIcon } from "@/components/AuthShell";
import { trustedApplicationOrigin } from "@/lib/safe-url";
import { redirectAuthenticatedVisitor } from "@/lib/auth-entry";
import { handleWebMcpFormSubmit } from "@/lib/webmcp";

const lookupUsername = (username: string) => checkUsername({ data: { username } });

export const Route = createFileRoute("/signup")({
  beforeLoad: async () => {
    await redirectAuthenticatedVisitor();
  },
  head: () => ({ meta: [{ title: "Create your creator storefront | bento.surf" }] }),
  component: SignupPage,
});

function SignupPage() {
  const navigate = useNavigate();
  const [step, setStep] = useState<1 | 2>(1);
  const { username, setUsername, available, availabilityError, retry } =
    useUsernameAvailability(lookupUsername);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [loading, setLoading] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);
  const [resendLoading, setResendLoading] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [confirmationEmail, setConfirmationEmail] = useState<string | null>(null);

  const claim = (event: FormEvent<HTMLFormElement>) =>
    handleWebMcpFormSubmit(event, () => {
      if (available !== true) {
        return { ok: false, message: "Choose an available creator URL before continuing." };
      }
      captureProductEvent("signup_started", { method: "email", username_selected: true });
      setStep(2);
      return { ok: true, message: "Creator URL selected. Continue to account setup." };
    });

  const handleSignup = (event: FormEvent<HTMLFormElement>) =>
    handleWebMcpFormSubmit(event, async () => {
      setAuthError(null);
      if (
        !email.trim() ||
        email.trim().length > 254 ||
        password.length < 8 ||
        password.length > 128
      ) {
        const message = "Enter a valid email and an 8+ character password.";
        setAuthError(message);
        toast.error(message);
        return { ok: false, message: "Account setup needs valid credentials." };
      }
      storePendingUsername(window.sessionStorage, username);
      setLoading(true);
      try {
        const authOrigin = trustedApplicationOrigin(
          window.location.origin,
          import.meta.env.VITE_APP_URL,
        );
        const { data, error } = await supabase.auth.signUp({
          email: email.trim(),
          password,
          options: { emailRedirectTo: `${authOrigin}/onboarding` },
        });
        if (error) throw error;
        captureProductEvent("signup_completed", {
          method: "email",
          confirmation_required: !data.session,
        });
        if (data.session) {
          await navigate({ to: "/onboarding", replace: true });
          return { ok: true, message: "Account created. Opening Bento onboarding." };
        }
        setConfirmationEmail(email.trim());
        return { ok: true, message: "Account created. Check your email to confirm it." };
      } catch (error) {
        const message = getAuthErrorMessage(error);
        setAuthError(message);
        toast.error(message);
        return {
          ok: false,
          message: "Account creation did not complete. Review the form error and try again.",
        };
      } finally {
        setLoading(false);
      }
    });

  const resendConfirmation = async () => {
    if (!confirmationEmail) return;
    setResendLoading(true);
    try {
      const authOrigin = trustedApplicationOrigin(
        window.location.origin,
        import.meta.env.VITE_APP_URL,
      );
      const { error } = await supabase.auth.resend({
        type: "signup",
        email: confirmationEmail,
        options: { emailRedirectTo: `${authOrigin}/onboarding` },
      });
      if (error) throw error;
      toast.success("A fresh confirmation link is on its way.");
    } catch (error) {
      toast.error(getAuthErrorMessage(error));
    } finally {
      setResendLoading(false);
    }
  };

  const handleGoogle = async () => {
    setAuthError(null);
    setGoogleLoading(true);
    const toastId = toast.loading("Opening Google sign-in…");
    try {
      storePendingUsername(window.sessionStorage, username);
      captureProductEvent("signup_started", { method: "google", username_selected: true });
      const authOrigin = trustedApplicationOrigin(
        window.location.origin,
        import.meta.env.VITE_APP_URL,
      );
      const { error } = await supabase.auth.signInWithOAuth({
        provider: "google",
        options: { redirectTo: `${authOrigin}/onboarding` },
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
      <div className="mb-8 flex items-center gap-2" aria-label={`Step ${step} of 2`}>
        {[1, 2].map((item) => (
          <span
            key={item}
            className={`h-px transition-all ${item === step ? "w-10 bg-black" : "w-6 bg-black/15"}`}
          />
        ))}
        <span className="ml-1 text-xs text-black/40">{step} of 2</span>
      </div>

      {confirmationEmail ? (
        <div className="max-w-lg">
          <div className="flex size-11 items-center justify-center rounded-full border border-black/10 bg-white text-black">
            <Mail className="size-5" />
          </div>
          <h1 className="mt-6 font-display text-4xl leading-none sm:text-5xl">Check your email</h1>
          <p className="mt-4 max-w-md text-sm leading-6 text-black/50">
            We sent a confirmation link to{" "}
            <strong className="font-medium text-black">{confirmationEmail}</strong>. Open it to
            claim <strong className="font-medium text-black">bento.surf/@{username}</strong> and
            finish your storefront.
          </p>
          <p className="mt-5 text-sm text-black/40">
            Can’t find it? Check spam or promotions. It may take a minute to arrive.
          </p>
          <button
            type="button"
            onClick={resendConfirmation}
            disabled={resendLoading}
            className="mt-6 inline-flex h-11 items-center gap-2 rounded-xl border border-black/10 bg-white px-4 text-sm font-medium transition hover:border-black/20 disabled:opacity-50"
          >
            <RotateCw className={`size-4 ${resendLoading ? "animate-spin" : ""}`} />
            {resendLoading ? "Sending…" : "Resend confirmation"}
          </button>
        </div>
      ) : step === 1 ? (
        <form
          onSubmit={claim}
          className="max-w-lg"
          toolname="bento_choose_creator_url"
          tooldescription="Fills a creator URL choice for the user to review and continue."
        >
          <h1 className="font-display text-4xl leading-none sm:text-5xl">Claim your Bento link</h1>
          <p className="mt-3 max-w-md text-sm leading-6 text-black/50">
            Choose the address you’ll share with your audience.
          </p>

          <label className="mt-7 block">
            <span className="mb-2 flex items-center justify-between text-sm font-medium">
              Your Bento URL
              <span className="text-xs font-normal text-black/40">3–24 characters</span>
            </span>
            <span className="flex h-12 items-center rounded-xl border border-black/10 bg-white px-3.5 transition focus-within:border-black/35 focus-within:ring-2 focus-within:ring-black/[0.06]">
              <span className="shrink-0 text-sm text-black/40">bento.surf/@</span>
              <input
                name="username"
                toolparamdescription="Creator username used in the public bento.surf URL."
                required
                minLength={3}
                maxLength={24}
                pattern="[a-z0-9_]+"
                autoFocus
                autoCapitalize="none"
                autoCorrect="off"
                value={username}
                onChange={(event) =>
                  setUsername(normalizeUsername(event.target.value).replace(/[^a-z0-9_]/g, ""))
                }
                placeholder="yourname"
                aria-describedby="username-status"
                className="min-w-0 flex-1 bg-transparent text-sm font-medium outline-none placeholder:text-black/25"
              />
              {available === true && (
                <span className="ml-2 flex size-6 shrink-0 items-center justify-center rounded-full bg-black text-white">
                  <Check className="size-3.5" />
                </span>
              )}
              {available === false && (
                <span className="ml-2 shrink-0 text-xs font-medium text-red-600">Taken</span>
              )}
            </span>
          </label>

          <div id="username-status" className="mt-2 min-h-5 text-sm">
            {availabilityError ? (
              <span className="flex items-center gap-3 text-red-600" role="alert">
                Couldn’t check that link.
                <button type="button" onClick={retry} className="font-medium underline">
                  Retry
                </button>
              </span>
            ) : available === true ? (
              <span className="text-black/55">Available</span>
            ) : available === false ? (
              <span className="text-red-600">Try a different username.</span>
            ) : username.length >= 3 ? (
              <span className="text-black/40">Checking availability…</span>
            ) : (
              <span className="text-black/40">Use letters, numbers, or an underscore.</span>
            )}
          </div>

          <button
            type="submit"
            disabled={available !== true}
            className="group mt-4 flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-black px-5 text-sm font-medium text-white transition hover:bg-black/85 disabled:opacity-35"
          >
            Continue
            <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />
          </button>

          <p className="mt-7 text-center text-sm text-black/50">
            Already have a Bento?{" "}
            <Link
              to="/login"
              search={{ redirect: "/link" }}
              className="font-medium text-black hover:underline"
            >
              Sign in
            </Link>
          </p>
        </form>
      ) : (
        <div className="max-w-lg">
          <button
            type="button"
            onClick={() => setStep(1)}
            className="mb-6 inline-flex size-10 items-center justify-center rounded-full border border-black/10 bg-white transition hover:border-black/20"
            aria-label="Back to choose a creator link"
          >
            <ArrowLeft className="size-4" />
          </button>
          <span className="block text-sm text-black/45">bento.surf/@{username}</span>
          <h1 className="mt-3 font-display text-4xl leading-none sm:text-5xl">
            Create your account
          </h1>
          <p className="mt-3 text-sm leading-6 text-black/50">
            Continue with Google or use your email.
          </p>

          <button
            type="button"
            onClick={handleGoogle}
            disabled={loading || googleLoading}
            className="mt-7 flex h-12 w-full items-center justify-center gap-3 rounded-xl border border-black/10 bg-white px-4 text-sm font-medium transition hover:border-black/20 hover:bg-black/[0.015] disabled:opacity-50"
          >
            <GoogleIcon />
            {googleLoading ? "Opening Google…" : "Continue with Google"}
          </button>

          <AuthDivider />

          <form
            onSubmit={handleSignup}
            noValidate
            className="space-y-4"
            toolname="bento_prepare_account_signup"
            tooldescription="Fills the Bento email sign-up form for the user to review and submit."
          >
            <AuthField
              name="email"
              toolparamdescription="Email address for the new Bento account."
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
              toolparamdescription="New Bento password between 8 and 128 characters."
              label="Password"
              hint="8+ characters"
              type={showPw ? "text" : "password"}
              autoComplete="new-password"
              required
              minLength={8}
              maxLength={128}
              value={password}
              onChange={(event) => {
                setPassword(event.target.value);
                setAuthError(null);
              }}
              placeholder="Create a password"
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
              {loading ? "Creating account…" : "Create account"}
              {!loading && (
                <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />
              )}
            </button>
          </form>

          <p className="mt-5 text-center text-xs leading-5 text-black/40">
            By continuing, you agree to Bento&apos;s{" "}
            <Link to="/terms" className="font-medium text-black/60 underline underline-offset-2">
              terms
            </Link>{" "}
            and{" "}
            <Link to="/privacy" className="font-medium text-black/60 underline underline-offset-2">
              privacy policy
            </Link>
            .
          </p>
        </div>
      )}
    </AuthShell>
  );
}

function getAuthErrorMessage(error: unknown) {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "object" && error && "message" in error) return String(error.message);
  return "Authentication failed. Please try again.";
}
