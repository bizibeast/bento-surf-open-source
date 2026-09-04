import { Info } from "lucide-react";
import { useId } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

export type PostSettingsValue = {
  subject: string;
  previewText: string;
  listId: string;
  webVisibility: "private" | "public" | "paid";
  publicSlug: string;
  scheduledAt: string;
};

const inputClass =
  "min-w-0 rounded-xl border border-black/[0.08] bg-white px-3 py-2.5 text-sm outline-none focus:border-[#3478f6]/45";

export function PostSettingsDialog({
  value,
  onChange,
  audiences = [],
  mode = "newsletter",
  scheduleEnabled = false,
}: {
  value: PostSettingsValue;
  onChange: (value: PostSettingsValue) => void;
  audiences?: Array<{ id: string; name: string }>;
  mode?: "newsletter" | "broadcast";
  scheduleEnabled?: boolean;
}) {
  const scheduleInputId = useId();
  const scheduleDescriptionId = useId();
  const update = <Key extends keyof PostSettingsValue>(
    key: Key,
    nextValue: PostSettingsValue[Key],
  ) => onChange({ ...value, [key]: nextValue });

  return (
    <Dialog>
      <DialogTrigger asChild>
        <button
          type="button"
          className="rounded-xl border border-black/[0.08] px-3 py-2 text-xs font-semibold"
        >
          Post settings
        </button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Post settings</DialogTitle>
          <DialogDescription>
            Set email delivery and web access without interrupting the writing canvas.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="grid gap-1.5 text-xs font-semibold text-[#17213a]/60 sm:col-span-2">
            Subject
            <input
              value={value.subject}
              maxLength={180}
              onChange={(event) => update("subject", event.target.value)}
              className={inputClass}
            />
          </label>
          <label className="grid gap-1.5 text-xs font-semibold text-[#17213a]/60 sm:col-span-2">
            Preview text
            <input
              value={value.previewText}
              maxLength={240}
              onChange={(event) => update("previewText", event.target.value)}
              className={inputClass}
            />
          </label>
          {mode === "newsletter" ? (
            <label className="grid gap-1.5 text-xs font-semibold text-[#17213a]/60">
              Audience
              <select
                value={value.listId}
                onChange={(event) => update("listId", event.target.value)}
                className={inputClass}
              >
                <option value="">All subscribers</option>
                {audiences.map((audience) => (
                  <option key={audience.id} value={audience.id}>
                    {audience.name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <div className="grid gap-1.5 text-xs font-semibold text-[#17213a]/60">
            <label htmlFor={scheduleInputId}>Schedule</label>
            <input
              id={scheduleInputId}
              type="datetime-local"
              value={value.scheduledAt}
              disabled={!scheduleEnabled}
              aria-describedby={!scheduleEnabled ? scheduleDescriptionId : undefined}
              onChange={(event) => update("scheduledAt", event.target.value)}
              className={inputClass}
            />
            {!scheduleEnabled ? (
              <span id={scheduleDescriptionId} className="font-normal text-[#17213a]/45">
                Connect delivery before scheduling this post.
              </span>
            ) : null}
          </div>
          {mode === "newsletter" ? (
            <>
              <div className="grid gap-1.5 text-xs font-semibold text-[#17213a]/60">
                <span className="flex items-center gap-1.5">
                  <label htmlFor="post-web-visibility">Web visibility</label>
                  <TooltipProvider delayDuration={0}>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          aria-label="About paid access"
                          className="inline-flex size-5 items-center justify-center rounded-full text-[#17213a]/45"
                        >
                          <Info className="size-3.5" />
                        </button>
                      </TooltipTrigger>
                      <TooltipContent>
                        Paid web previews hide the post body from non-subscribers.
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                </span>
                <select
                  id="post-web-visibility"
                  value={value.webVisibility}
                  onChange={(event) =>
                    update(
                      "webVisibility",
                      event.target.value as PostSettingsValue["webVisibility"],
                    )
                  }
                  className={inputClass}
                >
                  <option value="private">Private</option>
                  <option value="public">Public access</option>
                  <option value="paid">Paid access</option>
                </select>
              </div>
              <label className="grid gap-1.5 text-xs font-semibold text-[#17213a]/60">
                Post slug
                <input
                  value={value.publicSlug}
                  maxLength={96}
                  disabled={value.webVisibility === "private"}
                  onChange={(event) => update("publicSlug", event.target.value)}
                  className={inputClass}
                />
              </label>
            </>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
