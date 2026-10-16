import { useId } from "react";
import { ExternalLink, Globe, Users } from "lucide-react";
import { micro } from "@/lib/micro-app-ui";
import { xCommunityId, type XCommunity } from "@/lib/x-community";

export function XCommunityPicker({
  value,
  onChange,
  recent = [],
}: {
  value: XCommunity | null;
  onChange: (value: XCommunity | null) => void;
  recent?: XCommunity[];
}) {
  const fieldId = useId();
  const id = xCommunityId(value?.id);
  return (
    <div className="mt-4 min-w-0 border-t border-border/70 pt-4">
      <p className="text-xs font-semibold text-muted-foreground">Post to</p>
      <div className="mt-2 flex flex-wrap gap-2" role="group" aria-label="X post destination">
        <button
          type="button"
          aria-pressed={!value}
          title="Publish a regular X post"
          className={!value ? micro.btnInk : micro.btnSoft}
          onClick={() => onChange(null)}
        >
          <Globe className="size-4" /> Everyone
        </button>
        <button
          type="button"
          aria-pressed={!!value}
          title="Post inside an X community you have joined"
          className={value ? micro.btnInk : micro.btnSoft}
          onClick={() => onChange(value || { id: "", name: "" })}
        >
          <Users className="size-4" /> Community
        </button>
      </div>
      {value && (
        <div className="mt-3 space-y-3">
          {recent.length > 0 && (
            <label className="block text-xs font-medium">
              Recent communities
              <select
                aria-label="Recent X communities"
                className={`scheduler-select ${micro.input} mt-1 w-full min-w-0`}
                value={recent.some((item) => item.id === id) ? id! : ""}
                onChange={(event) =>
                  onChange(
                    recent.find((item) => item.id === event.target.value) || { id: "", name: "" },
                  )
                }
              >
                <option value="">Add a community</option>
                {recent.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name || `Community ${item.id}`}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="block text-xs font-medium" htmlFor={fieldId}>
            Community link or ID
            <input
              id={fieldId}
              className={`${micro.input} mt-1 w-full min-w-0`}
              placeholder="https://x.com/i/communities/…"
              maxLength={300}
              value={value.id}
              onChange={(event) => onChange({ ...value, id: event.target.value })}
              aria-describedby={`${fieldId}-help`}
            />
          </label>
          <label className="block text-xs font-medium">
            Community name (optional)
            <input
              className={`${micro.input} mt-1 w-full min-w-0`}
              placeholder="A name to recognize it next time"
              maxLength={80}
              value={value.name || ""}
              onChange={(event) => onChange({ ...value, name: event.target.value })}
            />
          </label>
          <p id={`${fieldId}-help`} className="text-xs leading-relaxed text-muted-foreground">
            Paste the link from a community you have joined on X. Saved posts keep it in your recent
            choices. X checks membership and posting permissions. Community posts can still be
            publicly visible.
          </p>
          {value.id.trim() && !id && (
            <p role="alert" className="text-xs text-destructive">
              Use an X community link or its numeric ID.
            </p>
          )}
          {id && (
            <a
              href={`https://x.com/i/communities/${id}`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-xs font-medium text-primary"
              title="Check this community and its rules on X"
            >
              Open community on X <ExternalLink className="size-3" />
            </a>
          )}
        </div>
      )}
    </div>
  );
}
