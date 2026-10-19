import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { ArrowRight, Download, Eye, EyeOff, KeyRound, LockKeyhole, RefreshCw } from "lucide-react";
import envTemplate from "@/lib/self-hosted-template.txt?raw";
import {
  buildSetupEnv,
  parseSetupFields,
  validateSetup,
  type SetupField,
} from "@/lib/self-hosted-setup";

const fields = parseSetupFields(envTemplate);
const essentialFields = fields.filter((field) => field.required);
const optionalGroups = [
  ...new Set(fields.filter((field) => !field.required).map((field) => field.group)),
];
const initialValues = Object.fromEntries(fields.map((field) => [field.name, field.defaultValue]));

export const Route = createFileRoute("/self-hosted-setup")({
  head: () => ({
    meta: [
      { title: "Set up your self-hosted Bento Surf" },
      { name: "robots", content: "noindex, nofollow" },
    ],
  }),
  component: SelfHostedSetup,
});

function SelfHostedSetup() {
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(true), []);
  const [values, setValues] = useState<Record<string, string>>(() => ({ ...initialValues }));
  const [errors, setErrors] = useState<string[]>([]);
  const [visible, setVisible] = useState<string[]>([]);
  const appReady = Boolean(
    import.meta.env.VITE_SUPABASE_URL && import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
  );

  const update = (name: string, value: string) => {
    setValues((current) => ({ ...current, [name]: value }));
    if (errors.length) setErrors([]);
  };

  const generateSigningKey = () => {
    const bytes = new Uint8Array(48);
    crypto.getRandomValues(bytes);
    update(
      "WORKSPACE_COOKIE_SIGNING_KEY",
      Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(""),
    );
  };

  const download = () => {
    const problems = validateSetup(values);
    setErrors(problems);
    if (problems.length) {
      document
        .getElementById("setup-errors")
        ?.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }
    const blob = new Blob([buildSetupEnv(envTemplate, values)], {
      type: "text/plain;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "bento-surf.env";
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
  };

  const renderField = (field: SetupField) => {
    const isVisible = visible.includes(field.name);
    return (
      <div key={field.name} className="rounded-2xl border border-black/10 bg-white p-4 sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <label
            htmlFor={`setup-${field.name}`}
            className="font-mono text-xs font-semibold tracking-tight text-black sm:text-sm"
          >
            {field.name}
          </label>
          <span className="rounded-full bg-black/[0.05] px-2.5 py-1 text-[11px] font-medium text-black/60">
            {field.feature}
            {field.required ? " · Required" : " · Optional"}
          </span>
        </div>
        <p id={`setup-${field.name}-help`} className="mt-2 text-sm leading-6 text-black/55">
          {field.purpose}
        </p>
        <div className="mt-3 flex gap-2">
          <input
            disabled={!ready}
            id={`setup-${field.name}`}
            type={field.secret && !isVisible ? "password" : "text"}
            value={values[field.name] ?? ""}
            onChange={(event) => update(field.name, event.target.value)}
            aria-describedby={`setup-${field.name}-help`}
            autoComplete="off"
            spellCheck={false}
            placeholder={field.secret ? "Paste your secret" : "Enter a value"}
            className="min-w-0 flex-1 rounded-xl border border-black/10 bg-[#fafaf9] px-3 py-2.5 font-mono text-sm text-black outline-none transition focus:border-black/40 focus:ring-2 focus:ring-black/[0.06]"
          />
          {field.secret && (
            <button
              type="button"
              disabled={!ready}
              onClick={() =>
                setVisible((current) =>
                  isVisible
                    ? current.filter((name) => name !== field.name)
                    : [...current, field.name],
                )
              }
              aria-label={`${isVisible ? "Hide" : "Show"} ${field.name}`}
              className="rounded-xl border border-black/10 px-3 text-black/60 hover:bg-black/[0.04]"
            >
              {isVisible ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
            </button>
          )}
        </div>
        {field.name === "WORKSPACE_COOKIE_SIGNING_KEY" && (
          <button
            type="button"
            disabled={!ready}
            onClick={generateSigningKey}
            className="mt-3 inline-flex items-center gap-1.5 text-xs font-medium text-black/65 underline underline-offset-4 hover:text-black"
          >
            <RefreshCw className="size-3.5" /> Generate a random key
          </button>
        )}
      </div>
    );
  };

  return (
    <main className="min-h-screen bg-[#f7f8fc] px-4 py-10 text-black sm:px-6 sm:py-16">
      <div className="mx-auto max-w-4xl">
        <div className="mb-8 flex items-center gap-2 text-sm font-semibold tracking-tight">
          <span className="flex size-8 items-center justify-center rounded-xl bg-black text-white">
            <KeyRound className="size-4" />
          </span>
          Bento Surf <span className="font-normal text-black/45">/ self-hosted setup</span>
        </div>

        <div className="rounded-[2rem] border border-black/10 bg-white p-6 shadow-sm sm:p-10">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-[#e9f3ed] px-3 py-1 text-xs font-medium text-[#245e3b]">
            <LockKeyhole className="size-3.5" /> Before creator onboarding
          </span>
          <h1 className="mt-5 max-w-2xl font-display text-4xl leading-tight sm:text-5xl">
            Make this instance yours.
          </h1>
          <p className="mt-4 max-w-2xl text-sm leading-7 text-black/60 sm:text-base">
            Add your Supabase project and instance keys here. Each field explains the feature it
            enables. Optional providers can be added now or later.
          </p>
          <div className="mt-6 rounded-2xl border border-[#cfdcec] bg-[#f3f7fc] p-4 text-sm leading-6 text-[#314864]">
            Values stay in this browser tab until you download the configuration file. This screen
            does not save or transmit your secrets. Keep the downloaded file private and out of
            version control.
          </div>
        </div>

        <section className="mt-10" aria-labelledby="setup-essentials">
          <div className="mb-5 flex items-baseline justify-between gap-3">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-black/40">
                Step 1
              </p>
              <h2 id="setup-essentials" className="mt-1 font-display text-3xl">
                Connect the essentials
              </h2>
            </div>
            <span className="text-xs text-black/45">{essentialFields.length} fields</span>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">{essentialFields.map(renderField)}</div>
          <p className="mt-4 text-sm leading-6 text-black/55">
            The download also fills the matching browser Supabase values and migration confirmation
            for you. Apply the supplied migrations before inviting users.
          </p>
        </section>

        <section className="mt-12" aria-labelledby="setup-optional">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-black/40">Step 2</p>
          <h2 id="setup-optional" className="mt-1 font-display text-3xl">
            Choose your integrations
          </h2>
          <p className="mt-2 text-sm leading-6 text-black/55">
            Open only the features you plan to use. Empty optional values leave those provider
            features unavailable.
          </p>
          <div className="mt-5 space-y-3">
            {optionalGroups.map((group) => {
              const groupFields = fields.filter(
                (field) => !field.required && field.group === group,
              );
              const filled = groupFields.filter((field) => values[field.name]?.trim()).length;
              return (
                <details key={group} className="group rounded-2xl border border-black/10 bg-white">
                  <summary className="flex cursor-pointer list-none items-center justify-between gap-4 p-5 marker:hidden">
                    <span>
                      <span className="block text-sm font-semibold">{group}</span>
                      <span className="mt-1 block text-xs leading-5 text-black/50">
                        {groupFields[0]?.feature} · {groupFields.length} settings
                      </span>
                    </span>
                    <span className="text-xs text-black/45">
                      {filled ? `${filled} filled` : "Add keys"} <span aria-hidden="true">↓</span>
                    </span>
                  </summary>
                  <div className="grid gap-3 border-t border-black/10 p-4 sm:grid-cols-2">
                    {groupFields.map(renderField)}
                  </div>
                </details>
              );
            })}
          </div>
        </section>

        <section
          className="mt-12 rounded-[2rem] bg-[#192131] p-6 text-white sm:p-8"
          aria-labelledby="setup-finish"
        >
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-white/50">Step 3</p>
          <h2 id="setup-finish" className="mt-1 font-display text-3xl">
            Start your instance
          </h2>
          <p className="mt-3 max-w-2xl text-sm leading-6 text-white/70">
            Download the file, place it at the repository root as{" "}
            <code className="text-white">.env</code>, then run the guarded Supabase migration and
            restart the app. Hosted deployments must set the same variables in their host and
            rebuild so browser settings are included.
          </p>
          <p className="mt-3 max-w-2xl text-xs leading-5 text-white/55">
            Already have an instance? Merge new values into your existing configuration. This screen
            cannot read back keys you previously installed.
          </p>
          <div className="mt-4 overflow-x-auto rounded-xl bg-white/10 p-4 font-mono text-xs leading-6 text-white/80">
            bun scripts/migrate-supabase.ts --dry-run
            <br />
            bun scripts/migrate-supabase.ts
            <br />
            bun run dev
          </div>
          {errors.length > 0 && (
            <div
              id="setup-errors"
              role="alert"
              className="mt-5 rounded-xl bg-[#ffe4e4] p-4 text-sm text-[#8a2020]"
            >
              <p className="font-semibold">Complete these essentials first:</p>
              <ul className="mt-2 list-disc space-y-1 pl-5">
                {errors.map((error) => (
                  <li key={error}>{error}</li>
                ))}
              </ul>
            </div>
          )}
          <div className="mt-6 flex flex-wrap items-center gap-3">
            <button
              type="button"
              disabled={!ready}
              onClick={download}
              className="inline-flex h-11 items-center gap-2 rounded-xl bg-white px-5 text-sm font-semibold text-[#192131] hover:bg-white/90"
            >
              <Download className="size-4" /> Download configuration
            </button>
            {appReady && (
              <a
                href="/signup"
                className="inline-flex h-11 items-center gap-2 px-3 text-sm font-medium text-white/85 hover:text-white"
              >
                Continue to creator onboarding <ArrowRight className="size-4" />
              </a>
            )}
          </div>
          {!appReady && (
            <p className="mt-4 text-xs text-white/55">
              The creator sign-up link appears after the app is restarted with its Supabase browser
              settings.
            </p>
          )}
        </section>
      </div>
    </main>
  );
}
