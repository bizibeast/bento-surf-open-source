import {
  Bookmark,
  BookmarkMinus,
  Check,
  Copy,
  Film,
  Images,
  Eye,
  MessageCircle,
  Plus,
  Repeat2,
  Search,
  Sparkles,
  Zap,
} from "lucide-react";
import { toast } from "sonner";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { DiscoverRecommendation } from "@/lib/content-discovery.functions";
import type { DiscoverActions } from "./DiscoverPost";
import { discoverAgentPrompt } from "./discover-utils";
import { publicDiscoverEvidenceUrl } from "@/lib/content-discover-identity";

const studioActions = [
  { format: "carousel", title: "Create carousel", Icon: Images },
  { format: "reel", title: "Create reel", Icon: Film },
] as const;

export function DiscoverPostActionMenu({
  item,
  actions,
  detail = false,
}: {
  item: DiscoverRecommendation;
  actions: DiscoverActions;
  detail?: boolean;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={detail ? "discover-detail-action" : "discover-icon-button"}
          aria-label="Post actions"
          title="Post actions"
        >
          <Zap />
          <span className={detail ? "" : "sr-only"}>Actions</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={6} className="discover-menu w-64">
        <DropdownMenuItem onSelect={() => actions.onAskAgent(item, "chat")}>
          <MessageCircle />
          <span>
            Send to Benny<small>Discuss this post in Agent</small>
          </span>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>Use as inspiration</DropdownMenuLabel>
        <DropdownMenuItem onSelect={() => actions.onAskAgent(item, "variations")}>
          <Sparkles />
          <span>
            Variations<small>Generate fresh angles</small>
          </span>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => actions.onAskAgent(item, "hooks")}>
          <Zap />
          Generate stronger hooks
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => actions.onAskAgent(item, "reverse-engineer")}>
          <Search />
          <span>
            Reverse Engineer<small>Break down why it works</small>
          </span>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => actions.onCreateDraft(item)}>
          <Repeat2 />
          <span>
            Remix<small>Draft an original take in your voice</small>
          </span>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => actions.onAskAgent(item, "brief")}>
          <Plus />
          Create content brief
        </DropdownMenuItem>
        {actions.onCreateStudio &&
          studioActions.map(({ format, title, Icon }) => (
            <DropdownMenuItem
              key={format}
              onSelect={() =>
                actions.onCreateStudio?.({
                  format,
                  title: item.title,
                  text: item.summary,
                  url: publicDiscoverEvidenceUrl(item.sourceUrl),
                })
              }
            >
              <Icon />
              {title}
            </DropdownMenuItem>
          ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={() => {
            void (async () => {
              try {
                await navigator.clipboard.writeText(discoverAgentPrompt(item, "chat"));
                toast.success("Agent prompt copied.");
              } catch {
                toast.error("Agent prompt could not be copied.");
              }
            })();
          }}
        >
          <Copy />
          Copy Agent prompt
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function DiscoverSaveMenu({
  item,
  actions,
  detail = false,
}: {
  item: DiscoverRecommendation;
  actions: DiscoverActions;
  detail?: boolean;
}) {
  const saved = item.saved || item.feedback === "saved";
  if (saved && actions.onUnsave)
    return (
      <button
        type="button"
        className={detail ? "discover-detail-action" : "discover-icon-button"}
        aria-label="Unsave"
        title="Remove saved evidence"
        data-active
        disabled={actions.pending.has(item.id)}
        onClick={() => actions.onUnsave?.(item.id)}
      >
        <BookmarkMinus />
        <span className={detail ? "" : "sr-only"}>Unsave</span>
      </button>
    );
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={detail ? "discover-detail-action" : "discover-icon-button"}
          aria-label={saved ? "Saved" : "Save"}
          title={saved ? "Saved evidence" : "Save"}
          data-active={saved}
          disabled={actions.pending.has(item.id)}
        >
          {saved ? <Check /> : <Plus />}
          <span className={detail ? "" : "sr-only"}>{saved ? "Saved" : "Save"}</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={6} className="discover-menu w-64">
        <DropdownMenuItem disabled={saved} onSelect={() => actions.onSave(item.id)}>
          <Bookmark />
          <span>
            {saved ? "Saved evidence" : "Save evidence"}
            <small>Keep the source in your inspiration library</small>
          </span>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={actions.onShowSaved}>
          <Eye />
          <span>
            View saved posts<small>Your saved inspiration</small>
          </span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
