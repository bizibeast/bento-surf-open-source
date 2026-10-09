import { useState, type ComponentType } from "react";
import {
  ArrowLeft,
  Check,
  Clock3,
  Mail,
  Plus,
  RefreshCw,
  Sparkles,
  Sun,
  Sunset,
} from "lucide-react";
import { SiGithub as Github } from "react-icons/si";
import type { ContentRoutineInput } from "@/lib/content-routines.functions";
import type { ContentRoutineSchedule, ContentRoutineTemplate } from "@/lib/content-routines";
import type { SocialProvider } from "@/lib/social-scheduler";

export type ContentRoutineView = {
  id: string;
  template: ContentRoutineTemplate;
  enabled: boolean;
  schedule: ContentRoutineSchedule;
  timezone: string;
  platforms: SocialProvider[];
  next_run_at: string | null;
  last_run_at: string | null;
};
export type ContentRoutineActivity = {
  id: string;
  routine_id: string;
  status: string;
  result_count: number;
  error_message: string | null;
  scheduled_for: string;
};
type Preset = {
  key: string;
  label: string;
  description: string;
  group: string;
  template?: ContentRoutineTemplate;
  instructions?: string;
  provider?: string;
  platforms?: SocialProvider[];
  time?: string;
  weekly?: boolean;
  color: string;
  icon: ComponentType<{ className?: string }>;
};
const presets: Preset[] = [
  {
    key: "morning",
    label: "Good Morning",
    description: "One useful thing to start your day",
    group: "Daily rhythm",
    time: "08:00",
    color: "#f8e8e1",
    icon: Sun,
    instructions:
      "Give me a morning greeting and the most useful update from my Brain and recent connected sources. Cite evidence; say when nothing new is available.",
  },
  {
    key: "evening",
    label: "Evening Report",
    description: "Recaps posts and performance",
    group: "Daily rhythm",
    time: "18:00",
    color: "#f0e5f5",
    icon: Sunset,
    instructions:
      "Summarize today's posts and actual provider-backed performance. Explain what worked and one useful next step. Do not invent unavailable metrics.",
  },
  {
    key: "morning_ready_email",
    label: "Morning ready email",
    description: "Email when a new draft batch is ready",
    group: "Daily rhythm",
    template: "morning_ready_email",
    time: "07:00",
    color: "#eae7f8",
    icon: Mail,
  },
  {
    key: "github-x",
    label: "GitHub to X",
    description: "Turns shipped work into post drafts",
    group: "X / Twitter",
    provider: "github",
    platforms: ["twitter"],
    color: "#e9e8ef",
    icon: Github,
    instructions:
      "Read my connected GitHub changes and prepare an X post about the most meaningful shipped work. Include evidence and use my X strategy. Only draft; if there are no new changes, say so.",
  },
  {
    key: "granola-x",
    label: "Granola Posts",
    description: "Turns meetings into X drafts",
    group: "X / Twitter",
    provider: "granola",
    platforms: ["twitter"],
    color: "#f7e9df",
    icon: Sparkles,
    instructions:
      "Use my connected Granola meeting notes to find a useful insight and prepare an X draft in my voice. Exclude private third-party details and cite the source. If no relevant notes exist, say so.",
  },
  {
    key: "outliers-x",
    label: "Outliers",
    description: "Finds breakout posts to learn from",
    group: "X / Twitter",
    platforms: ["twitter"],
    color: "#f3f1ff",
    icon: RefreshCw,
    instructions:
      "Analyze my own X posts and provider-backed metrics. Find a breakout post relative to my baseline, explain why it worked, and prepare one fresh X draft. Never invent metrics.",
  },
  {
    key: "github-linkedin",
    label: "GitHub to LinkedIn",
    description: "Turns shipped work into a story",
    group: "LinkedIn",
    provider: "github",
    platforms: ["linkedin"],
    color: "#e7eff9",
    icon: Github,
    instructions:
      "Use my connected GitHub changes to prepare a story-led LinkedIn draft about a meaningful product decision. Follow my LinkedIn strategy and cite the real changes.",
  },
  {
    key: "granola-linkedin",
    label: "Meeting to Post",
    description: "Turns meeting lessons into drafts",
    group: "LinkedIn",
    provider: "granola",
    platforms: ["linkedin"],
    color: "#f8e8e1",
    icon: Sparkles,
    instructions:
      "Find a directly supported lesson in my connected Granola meeting notes and prepare a LinkedIn draft. Follow my strategy, cite the note, and exclude private third-party information.",
  },
  {
    key: "photo-carousel",
    label: "Photo Carousels",
    description: "Plans a carousel from your photos",
    group: "Instagram",
    provider: "instagram",
    platforms: ["instagram"],
    color: "#f3e8f2",
    icon: Sparkles,
    instructions:
      "Use my connected Instagram content and Brain photos to propose a carousel outline, slide copy, image source links, and caption. Only use real available images. This is a review-ready plan, not a rendered asset.",
  },
  {
    key: "nightly_niche_brief",
    label: "Nightly niche brief",
    description: "Fresh, cited developments in your niche",
    group: "Cross-platform",
    template: "nightly_niche_brief",
    time: "02:00",
    color: "#f6eee0",
    icon: Sparkles,
  },
  {
    key: "fill_schedule",
    label: "Fill my schedule",
    description: "Drafts for your empty posting slots",
    group: "Cross-platform",
    template: "fill_schedule",
    time: "03:00",
    color: "#e9e7f8",
    icon: Clock3,
  },
  {
    key: "repurpose",
    label: "Repurpose Winners",
    description: "Finds posts that fit elsewhere",
    group: "Cross-platform",
    color: "#e7f2e6",
    icon: RefreshCw,
    instructions:
      "Find one high-performing post using my actual provider metrics and prepare drafts adapted to my selected platforms. Keep its facts, change the structure for each platform, and avoid recently repeated hooks.",
  },
  {
    key: "repackage",
    label: "Repackage Old Posts",
    description: "Revives old lessons as fresh drafts",
    group: "Cross-platform",
    color: "#f5e8e8",
    icon: RefreshCw,
    instructions:
      "Find one older creator-owned post or confirmed Brain story worth revisiting. Prepare a fresh draft for each selected platform without inventing events, results or numbers. Explain the new angle.",
  },
  {
    key: "weekly_performance_review",
    label: "Weekly performance review",
    description: "Reviews your week against strategy",
    group: "Cross-platform",
    template: "weekly_performance_review",
    time: "09:00",
    weekly: true,
    color: "#e8eef8",
    icon: Clock3,
  },
  {
    key: "gardening",
    label: "Draft Gardening",
    description: "Reviews your drafts and next steps",
    group: "Cross-platform",
    color: "#edf3e6",
    icon: Sparkles,
    instructions:
      "Review my current drafts against my Brain strategies. Identify stale, duplicate, weak or unsupported premises and propose precise edits. Do not delete drafts or change their schedule; give me a review to act on.",
  },
];

export function ContentRoutines({
  routines,
  timezone,
  activity = [],
  connectedProviders = [],
  onSave,
  onPause,
  onClose,
}: {
  routines: ContentRoutineView[];
  timezone: string;
  activity?: ContentRoutineActivity[];
  connectedProviders?: string[];
  onSave: (value: ContentRoutineInput) => void | Promise<void>;
  onPause: (id: string, paused: boolean) => void | Promise<void>;
  onClose: () => void;
}) {
  const [selection, setSelection] = useState<{
    preset?: Preset;
    routine?: ContentRoutineView;
  } | null>(null);
  const [error, setError] = useState("");
  const custom = routines.filter(
    (routine) => routine.template.startsWith("custom:") && !routine.schedule.catalogKey,
  );
  const toggle = async (routine: ContentRoutineView) => {
    setError("");
    try {
      await onPause(routine.id, routine.enabled);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not change routine.");
    }
  };
  if (selection)
    return (
      <RoutineEditor
        key={selection.routine?.id || selection.preset?.key || "new"}
        preset={selection.preset}
        routine={selection.routine}
        timezone={timezone}
        activity={activity}
        onSave={onSave}
        onBack={() => setSelection(null)}
      />
    );
  return (
    <section
      aria-label="Content routines"
      className="content-workspace min-h-[calc(100dvh-3.5rem)] px-5 py-8 sm:px-8"
    >
      <div className="mx-auto max-w-5xl">
        <header className="mb-8 flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 className="text-[28px] font-semibold tracking-tight">Set Bento's rhythm.</h2>
            <p className="mt-1 text-sm text-neutral-500">
              Things Bento does when you're not looking.
            </p>
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
              className="content-action"
              aria-label="Close Routines"
            >
              <ArrowLeft className="size-4" />
              Agent
            </button>
            <button
              type="button"
              onClick={() => setSelection({})}
              className="content-action content-action-primary"
            >
              <Plus className="size-4" />
              New Routine
            </button>
          </div>
        </header>
        {error && (
          <p role="alert" className="mb-5 text-sm text-red-700">
            {error}
          </p>
        )}
        {[...new Set(presets.map((preset) => preset.group))].map((group) => (
          <section key={group} className="mb-9">
            <h3 className="mb-4 text-sm font-semibold">{group}</h3>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
              {presets
                .filter((preset) => preset.group === group)
                .map((preset) => {
                  const routine = routines.find((value) =>
                    preset.template
                      ? value.template === preset.template
                      : value.schedule.catalogKey === preset.key,
                  );
                  const available =
                    !preset.provider || connectedProviders.includes(preset.provider);
                  const Icon = preset.icon;
                  return (
                    <div key={preset.key} className="relative">
                      <button
                        type="button"
                        onClick={() => setSelection({ preset, routine })}
                        className="h-full min-h-32 w-full rounded-2xl border border-neutral-100 p-4 text-left transition hover:border-neutral-300"
                        style={{ background: preset.color }}
                      >
                        <Icon className="mb-5 size-6 text-neutral-700" />
                        <h4 className="text-xs font-semibold">{preset.label}</h4>
                        <p className="mt-1 text-xs leading-5 text-neutral-500">
                          {available
                            ? preset.description
                            : `Connect ${preset.provider} to use this`}
                        </p>
                        {routine?.enabled && (
                          <span
                            className="absolute right-3 top-3 rounded-full bg-green-600 p-0.5 text-white"
                            aria-label="Enabled"
                          >
                            <Check className="size-3" />
                          </span>
                        )}
                      </button>
                      {routine && (
                        <button
                          type="button"
                          role="switch"
                          aria-checked={routine.enabled}
                          aria-label={`${routine.enabled ? "Pause" : "Resume"} ${preset.label}`}
                          onClick={() => void toggle(routine)}
                          className={`mt-2 text-xs ${routine.enabled ? "text-green-700" : "text-neutral-400"}`}
                        >
                          {routine.enabled ? "On" : "Paused"}
                        </button>
                      )}
                    </div>
                  );
                })}
            </div>
          </section>
        ))}
        <section className="mb-8">
          <h3 className="mb-3 text-sm font-semibold">Your custom routines</h3>
          {custom.length ? (
            custom.map((routine) => (
              <div
                key={routine.id}
                className="flex items-center justify-between border-b border-neutral-100 py-4"
              >
                <button className="text-left" onClick={() => setSelection({ routine })}>
                  <p className="text-sm font-medium">{routine.schedule.name || "Routine"}</p>
                  <p className="mt-1 text-xs text-neutral-500">
                    {routine.schedule.intervalMinutes === 10_080 ? "Weekly" : "Daily"} ·{" "}
                    {routine.schedule.time} · {routine.timezone}
                  </p>
                </button>
                <button
                  type="button"
                  role="switch"
                  aria-checked={routine.enabled}
                  onClick={() => void toggle(routine)}
                  className="content-action"
                  aria-label={`${routine.enabled ? "Pause" : "Resume"} ${routine.schedule.name || "Routine"}`}
                >
                  {routine.enabled ? "On" : "Paused"}
                </button>
              </div>
            ))
          ) : (
            <p className="text-sm text-neutral-400">
              Add instructions and choose when Bento should run them.
            </p>
          )}
        </section>
        <details className="border-t border-neutral-100 pt-4">
          <summary className="cursor-pointer text-sm text-neutral-500">
            System activity · {activity.length} runs
          </summary>
          <Activity activity={activity} timezone={timezone} />
        </details>
      </div>
    </section>
  );
}
function RoutineEditor({
  preset,
  routine,
  timezone,
  activity,
  onSave,
  onBack,
}: {
  preset?: Preset;
  routine?: ContentRoutineView;
  timezone: string;
  activity: ContentRoutineActivity[];
  onSave: (value: ContentRoutineInput) => void | Promise<void>;
  onBack: () => void;
}) {
  const [name, setName] = useState(routine?.schedule.name || preset?.label || "");
  const [instructions, setInstructions] = useState(
    routine?.schedule.instructions || preset?.instructions || "",
  );
  const [time, setTime] = useState(routine?.schedule.time || preset?.time || "09:00");
  const [zone, setZone] = useState(routine?.timezone || timezone);
  const [interval, setInterval] = useState<1440 | 10080>(
    routine?.schedule.intervalMinutes === 10_080 || preset?.weekly ? 10_080 : 1_440,
  );
  const [platforms, setPlatforms] = useState<SocialProvider[]>(
    routine?.platforms || preset?.platforms || [],
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const save = async () => {
    setSaving(true);
    setError("");
    try {
      await onSave({
        template: routine?.template || preset?.template || `custom:${crypto.randomUUID()}`,
        enabled: routine?.enabled ?? true,
        intervalMinutes: interval,
        time,
        timezone: zone,
        platforms,
        ...(!preset?.template
          ? { name, instructions, ...(preset ? { catalogKey: preset.key } : {}) }
          : {}),
      });
      onBack();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save routine.");
    } finally {
      setSaving(false);
    }
  };
  return (
    <section className="content-workspace min-h-[calc(100dvh-3.5rem)] px-5 py-8">
      <div className="mx-auto max-w-2xl">
        <button
          type="button"
          onClick={onBack}
          className="mb-7 flex items-center gap-2 text-sm text-neutral-500"
        >
          <ArrowLeft className="size-4" />
          All routines
        </button>
        <h2 className="text-[28px] font-semibold">
          {preset?.label || routine?.schedule.name || "New Routine"}
        </h2>
        <p className="mt-2 text-sm leading-6 text-neutral-500">
          {preset?.description ||
            "Tell Bento what to do and when to do it. Results appear in Agent for review."}
        </p>
        <form
          className="mt-8 space-y-5"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          {!preset?.template && (
            <>
              <label className="block text-sm">
                Name
                <input
                  className="content-field mt-2"
                  value={name}
                  maxLength={100}
                  required
                  onChange={(event) => setName(event.target.value)}
                />
              </label>
              <label className="block text-sm">
                Instructions
                <textarea
                  className="content-field mt-2 min-h-40 resize-y"
                  value={instructions}
                  maxLength={4_000}
                  required
                  placeholder="Every morning, review my recent work and prepare one LinkedIn draft…"
                  onChange={(event) => setInstructions(event.target.value)}
                />
              </label>
            </>
          )}
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block text-sm">
              Frequency
              <select
                className="content-field mt-2"
                value={interval}
                onChange={(event) => setInterval(Number(event.target.value) as 1440 | 10080)}
              >
                <option value={1440}>Every day</option>
                <option value={10080}>Every week</option>
              </select>
            </label>
            <label className="block text-sm">
              Run time
              <input
                className="content-field mt-2"
                type="time"
                value={time}
                required
                onChange={(event) => setTime(event.target.value)}
              />
            </label>
          </div>
          <label className="block text-sm">
            Timezone
            <input
              className="content-field mt-2"
              value={zone}
              required
              onChange={(event) => setZone(event.target.value)}
            />
          </label>
          <fieldset>
            <legend className="text-sm">Platforms</legend>
            <div className="mt-3 flex flex-wrap gap-4">
              {(["twitter", "linkedin", "instagram", "threads", "youtube"] as const).map(
                (platform) => (
                  <label key={platform} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={platforms.includes(platform)}
                      onChange={(event) =>
                        setPlatforms((current) =>
                          event.target.checked
                            ? [...current, platform]
                            : current.filter((value) => value !== platform),
                        )
                      }
                    />
                    {platform === "twitter"
                      ? "X"
                      : platform === "linkedin"
                        ? "LinkedIn"
                        : platform[0].toUpperCase() + platform.slice(1)}
                  </label>
                ),
              )}
            </div>
          </fieldset>
          {routine && (
            <div className="flex flex-wrap gap-8 border-t border-neutral-100 pt-5 text-xs">
              <div>
                <p className="text-neutral-400">Last run</p>
                <p className="mt-1">
                  {date(routine.last_run_at, routine.timezone) || "Not run yet"}
                </p>
              </div>
              <div>
                <p className="text-neutral-400">Next run</p>
                <p className="mt-1">{date(routine.next_run_at, routine.timezone) || "Paused"}</p>
              </div>
            </div>
          )}
          {error && (
            <p role="alert" className="text-sm text-red-700">
              {error}
            </p>
          )}
          <button type="submit" disabled={saving} className="content-action content-action-primary">
            {saving ? "Saving…" : routine ? "Save routine" : "Enable routine"}
          </button>
        </form>
        {routine && (
          <Activity
            activity={activity.filter((run) => run.routine_id === routine.id)}
            timezone={routine.timezone}
          />
        )}
      </div>
    </section>
  );
}
function date(value: string | null, timezone: string) {
  if (!value) return "";
  return new Date(value).toLocaleString(undefined, { timeZone: timezone });
}
function Activity({
  activity,
  timezone,
}: {
  activity: ContentRoutineActivity[];
  timezone: string;
}) {
  return (
    <div className="mt-5 space-y-3">
      {activity.length ? (
        activity.map((run) => (
          <div key={run.id} className="border-b border-neutral-100 py-3 text-xs">
            <p>
              {date(run.scheduled_for, timezone)} · {run.status} · {run.result_count} results
            </p>
            {run.error_message && <p className="mt-1 text-red-700">{run.error_message}</p>}
          </div>
        ))
      ) : (
        <p className="text-xs text-neutral-400">No runs yet.</p>
      )}
    </div>
  );
}
