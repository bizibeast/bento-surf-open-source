import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { ArrowRight, Eye, EyeOff, Mail } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { AuthField, AuthShell } from "@/components/AuthShell";
import { supabase } from "@/integrations/supabase/client";
import { trustedApplicationOrigin } from "@/lib/safe-url";
import { handleWebMcpFormSubmit } from "@/lib/webmcp";

export const Route = createFileRoute("/reset-password")({
  head: () => ({ meta: [{ title: "Reset password | bento.surf" }] }),
  component: ResetPasswordPage,
});

// eslint-disable-next-line react-refresh/only-export-components
export function isPasswordRecoveryHash(hash: string) {
  return new URLSearchParams(hash.replace(/^#/, "")).get("type") === "recovery";
}

// eslint-disable-next-line react-refresh/only-export-components
export function validateNewPassword(password: string, confirmation: string) {
  if (password.length < 8 || password.length > 128) {
    return "Use a password between 8 and 128 characters.";
  }
  if (password !== confirmation) return "Passwords do not match.";
  return null;
}

function ResetPasswordPage() {
  const navigate = useNavigate();
  const [recoveryRequested] = useState(() =>
    typeof window === "undefined" ? false : isPasswordRecoveryHash(window.location.hash),
  );
  const [mode, setMode] = useState<"checking" | "request" | "sent" | "update">("checking");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, session) => {
      if (active && event === "PASSWORD_RECOVERY" && session) setMode("update");
    });
    void supabase.auth.getSession().then(({ data }) => {
      if (!active) return;
      setMode(recoveryRequested && data.session ? "update" : "request");
      if (recoveryRequested && !data.session) setError("This reset link is invalid or expired.");
    });
    return () => {
      active = false;
      subscription.unsubscribe();
    };
  }, [recoveryRequested]);

  const requestReset = (event: FormEvent<HTMLFormElement>) =>
    handleWebMcpFormSubmit(event, async () => {
      setError(null);
      const normalizedEmail = email.trim();
      if (!normalizedEmail || normalizedEmail.length > 254) {
        setError("Enter a valid email address.");
        return { ok: false, message: "Password reset needs a valid email address." };
      }
      setLoading(true);
      const authOrigin = trustedApplicationOrigin(
        window.location.origin,
        import.meta.env.VITE_APP_URL,
      );
      const { error: resetError } = await supabase.auth.resetPasswordForEmail(normalizedEmail, {
        redirectTo: `${authOrigin}/reset-password`,
      });
      setLoading(false);
      if (resetError) {
        setError(
          resetError.status === 429
            ? "Too many reset requests. Wait a few minutes and try again."
            : "We could not send a reset email. Please try again.",
        );
        return {
          ok: false,
          message: "Password reset did not complete. Review the form error and try again.",
        };
      }
      setMode("sent");
      return { ok: true, message: "Password reset email requested." };
    });

  const updatePassword = (event: FormEvent<HTMLFormElement>) =>
    handleWebMcpFormSubmit(event, async () => {
      const validationError = validateNewPassword(password, confirmation);
      setError(validationError);
      if (validationError) {
        return { ok: false, message: "Password update needs matching valid passwords." };
      }

      setLoading(true);
      const { error: updateError } = await supabase.auth.updateUser({ password });
      if (updateError) {
        setLoading(false);
        setError("Your password could not be updated. Request a new reset link and try again.");
        return {
          ok: false,
          message: "Password update did not complete. Request a new reset link and try again.",
        };
      }

      const { error: signOutError } = await supabase.auth.signOut({ scope: "global" });
      if (signOutError) {
        await supabase.auth.signOut({ scope: "local" });
        toast.warning("Password updated. Review active sessions after signing in.");
      } else {
        toast.success("Password updated. Sign in with your new password.");
      }
      setLoading(false);
      await navigate({
        to: "/login",
        search: { redirect: "/link" },
        replace: true,
      });
      return { ok: true, message: "Password updated. Sign in with the new password." };
    });

  if (mode === "checking") {
    return (
      <AuthShell>
        <p className="text-center text-sm text-black/50" role="status">
          Checking your reset link…
        </p>
      </AuthShell>
    );
  }

  if (mode === "sent") {
    return (
      <AuthShell>
        <div className="flex size-11 items-center justify-center rounded-full border border-black/10 bg-white">
          <Mail className="size-5" />
        </div>
        <h1 className="mt-6 font-display text-4xl leading-none sm:text-5xl">Check your email</h1>
        <p className="mt-4 text-sm leading-6 text-black/50">
          If an account exists for that email, we sent a password reset link. Check spam or
          promotions if it does not arrive.
        </p>
        <Link
          to="/login"
          search={{ redirect: "/link" }}
          className="mt-7 inline-flex text-sm font-medium text-black hover:underline"
        >
          Return to sign in
        </Link>
      </AuthShell>
    );
  }

  return (
    <AuthShell>
      <h1 className="font-display text-4xl leading-none sm:text-5xl">
        {mode === "update" ? "Choose a new password" : "Reset your password"}
      </h1>
      <p className="mt-3 text-sm leading-6 text-black/50">
        {mode === "update"
          ? "Your other sessions will be signed out after the password changes."
          : "Enter your email and we’ll send a secure reset link."}
      </p>

      <form
        onSubmit={mode === "update" ? updatePassword : requestReset}
        noValidate
        className="mt-7 space-y-4"
        toolname={
          mode === "update" ? "bento_prepare_password_update" : "bento_prepare_password_reset"
        }
        tooldescription={
          mode === "update"
            ? "Fills the new-password form for the user to review and submit."
            : "Fills the password-reset email form for the user to review and submit."
        }
      >
        {mode === "update" ? (
          <>
            <AuthField
              name="password"
              toolparamdescription="New password between 8 and 128 characters."
              label="New password"
              hint="8+ characters"
              type={showPassword ? "text" : "password"}
              minLength={8}
              maxLength={128}
              autoComplete="new-password"
              required
              value={password}
              onChange={(event) => {
                setPassword(event.target.value);
                setError(null);
              }}
              trailing={
                <button
                  type="button"
                  onClick={() => setShowPassword((value) => !value)}
                  aria-label={showPassword ? "Hide password" : "Show password"}
                  className="flex size-10 items-center justify-center rounded-lg text-black/40 hover:bg-black/[0.04]"
                >
                  {showPassword ? <EyeOff className="size-4.5" /> : <Eye className="size-4.5" />}
                </button>
              }
            />
            <AuthField
              name="confirmation"
              toolparamdescription="The same new password again for confirmation."
              label="Confirm password"
              type={showPassword ? "text" : "password"}
              minLength={8}
              maxLength={128}
              autoComplete="new-password"
              required
              value={confirmation}
              onChange={(event) => {
                setConfirmation(event.target.value);
                setError(null);
              }}
            />
          </>
        ) : (
          <AuthField
            name="email"
            toolparamdescription="Email address that should receive the password reset link."
            label="Email"
            type="email"
            maxLength={254}
            inputMode="email"
            autoComplete="email"
            required
            value={email}
            onChange={(event) => {
              setEmail(event.target.value);
              setError(null);
            }}
            placeholder="you@example.com"
          />
        )}

        {error && (
          <div
            className="rounded-xl border border-red-500/15 bg-red-50 px-4 py-3 text-sm text-red-700"
            role="alert"
          >
            {error}
          </div>
        )}

        <button
          type="submit"
          disabled={loading}
          className="group flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-black px-5 text-sm font-medium text-white transition hover:bg-black/85 disabled:opacity-50"
        >
          {loading
            ? mode === "update"
              ? "Updating…"
              : "Sending…"
            : mode === "update"
              ? "Update password"
              : "Send reset link"}
          {!loading && <ArrowRight className="size-4" />}
        </button>
      </form>

      {mode === "request" && (
        <p className="mt-7 text-center text-sm text-black/50">
          Remembered it?{" "}
          <Link
            to="/login"
            search={{ redirect: "/link" }}
            className="font-medium text-black hover:underline"
          >
            Sign in
          </Link>
        </p>
      )}
    </AuthShell>
  );
}
