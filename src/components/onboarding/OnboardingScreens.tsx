import { configuredPublicOrigin } from "@/lib/application-urls";
import { useState } from "react";
import {
  ArrowUpRight,
  BookOpen,
  Check,
  CheckCircle2,
  Feather,
  Loader2,
  Sparkles,
} from "lucide-react";
import { SiFacebook, SiInstagram, SiThreads, SiTiktok, SiX, SiYoutube } from "react-icons/si";
import { FaLinkedinIn } from "react-icons/fa";
import { ContentMarkdown } from "../content/ContentDocument";
import { SOCIAL_PROVIDER_DEFINITIONS } from "@/lib/social-scheduler";
import {
  ONBOARDING_PLATFORMS,
  type OnboardingBrief,
  type OnboardingCandidates,
} from "@/lib/onboarding/brief";
import type { OnboardingEvidence } from "@/lib/onboarding/evidence";
import { safeMediaUrl } from "@/lib/safe-url";
import {
  PAID_PLAN_IDS,
  PLAN_PRICING,
  planName,
  type BillingPeriod,
  type PaidPlanId,
} from "@/lib/plans";

const onboardingIcons = {
  instagram: SiInstagram,
  twitter: SiX,
  linkedin: FaLinkedinIn,
  facebook: SiFacebook,
  threads: SiThreads,
  tiktok: SiTiktok,
  youtube: SiYoutube,
};
export type OnboardingConnection = {
  id: string;
  provider: string;
  provider_handle: string;
  provider_display_name: string | null;
  provider_avatar_url: string | null;
};
const providerName = (provider: string) =>
  SOCIAL_PROVIDER_DEFINITIONS[provider as keyof typeof SOCIAL_PROVIDER_DEFINITIONS]?.name ||
  provider;

export function PersonAvatar({
  url,
  name,
  className = "",
}: {
  url?: string | null;
  name: string;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  return url && safeMediaUrl(url) && !failed ? (
    <img src={url} alt="" className={`ob-avatar ${className}`} onError={() => setFailed(true)} />
  ) : (
    <span aria-hidden="true" className={`ob-avatar ob-initials ${className}`}>
      {name.trim().slice(0, 1).toUpperCase() || "B"}
    </span>
  );
}

export function LinkIdentity({ username }: { username: string }) {
  return (
    <div className="ob-link-art" aria-hidden="true">
      <div className="ob-art-tile ob-art-mint">
        <span>made</span>
        <em>by you.</em>
      </div>
      <div className="ob-art-tile ob-art-lilac">
        <Sparkles />
        <span>
          Ideas, meet
          <br />
          possibility.
        </span>
      </div>
      <div className="ob-art-link">
        <span className="ob-link-dot" />
        {new URL(configuredPublicOrigin(import.meta.env.VITE_PUBLIC_URL)).host}/
        <strong>{username || "your-name"}</strong>
        <ArrowUpRight />
      </div>
    </div>
  );
}

export function SocialConnections({
  connections,
  primaryId,
  busy,
  onConnect,
  onUse,
}: {
  connections: OnboardingConnection[];
  primaryId: string | null;
  busy: boolean;
  onConnect: (provider: (typeof ONBOARDING_PLATFORMS)[number]) => void;
  onUse: (id: string) => void;
}) {
  return (
    <div className="ob-social-grid">
      {ONBOARDING_PLATFORMS.map((provider) => {
        const Icon = onboardingIcons[provider];
        const accounts = connections.filter((connection) => connection.provider === provider);
        return accounts.length ? (
          accounts.map((account) => (
            <button
              key={account.id}
              type="button"
              className={`ob-social ob-social-connected ob-social-${provider}`}
              disabled={busy}
              onClick={() => onUse(account.id)}
              aria-label={`${providerName(provider)} connected as ${account.provider_handle}`}
            >
              <div className="ob-social-top">
                <Icon />
                <span>{providerName(provider)}</span>
                <CheckCircle2 className="ob-connected-check" />
              </div>
              <div className="ob-social-person">
                <PersonAvatar
                  url={account.provider_avatar_url}
                  name={account.provider_display_name || account.provider_handle}
                />
                <span>
                  <strong>
                    {["linkedin", "facebook"].includes(provider)
                      ? account.provider_display_name || account.provider_handle
                      : `@${account.provider_handle.replace(/^@/, "")}`}
                  </strong>
                  <small>{primaryId === account.id ? "Profile selected" : "Connected"}</small>
                </span>
              </div>
            </button>
          ))
        ) : (
          <button
            key={provider}
            type="button"
            className={`ob-social ob-social-empty ob-social-${provider}`}
            disabled={busy}
            onClick={() => onConnect(provider)}
          >
            <Icon />
            <span>{providerName(provider)}</span>
            <ArrowUpRight />
          </button>
        );
      })}
    </div>
  );
}

export function PreparationInProgress({
  name,
  accountCount,
  jobStatus,
}: {
  name: string;
  accountCount: number;
  jobStatus: string;
}) {
  return (
    <div className="ob-preparing" role="status" aria-live="polite">
      <div className="ob-orbit" aria-hidden="true">
        <span className="ob-orbit-card ob-mint">
          <BookOpen />
        </span>
        <span className="ob-orbit-card ob-lilac">
          <Feather />
        </span>
        <span className="ob-orbit-card ob-yellow">
          <Sparkles />
        </span>
      </div>
      <h2>Connecting the dots, {name.split(" ")[0] || "for you"}.</h2>
      <p>
        {accountCount
          ? `Your ${accountCount === 1 ? "connected profile" : `${accountCount} connected profiles`}, available posts, and your answers are the starting point.`
          : "Your answers are becoming the starting point for your Brain."}
      </p>
      <div className="ob-preparing-status">
        <Loader2 className="motion-safe:animate-spin" />
        {jobStatus === "queued"
          ? "Your preparation is in the queue"
          : "Preparing your Brain and checking your first draft"}
      </div>
      <span className="ob-small">You can leave and come back. Your progress is saved.</span>
    </div>
  );
}

export function StandoutPost({
  post,
  brief,
}: {
  post: NonNullable<OnboardingEvidence["standout"]>;
  brief: OnboardingBrief;
}) {
  const Icon = onboardingIcons[post.provider as keyof typeof onboardingIcons];
  return (
    <article className={`ob-standout ${post.thumbnailUrl ? "ob-standout-with-image" : ""}`}>
      {post.thumbnailUrl && (
        <img
          className="ob-standout-image"
          src={post.thumbnailUrl}
          alt="Thumbnail from your imported post"
        />
      )}
      <div className="ob-standout-copy">
        <div className="ob-post-byline">
          <PersonAvatar url={brief.avatarUrl} name={brief.displayName} />
          <span>
            <strong>{brief.displayName}</strong>
            <small>{providerName(post.provider)} · from your connected account</small>
          </span>
          {Icon && <Icon />}
        </div>
        <p className="ob-post-excerpt">{post.caption}</p>
        <div className="ob-post-proof">
          <span>
            <strong>{new Intl.NumberFormat().format(post.engagements || 0)}</strong> recorded
            engagements
          </span>
          <span>
            Most engaged among {post.comparedPosts} imported {providerName(post.provider)} posts
          </span>
        </div>
        {post.url && (
          <a className="ob-text-link" href={post.url} target="_blank" rel="noreferrer">
            See your original post <ArrowUpRight />
          </a>
        )}
      </div>
    </article>
  );
}

export function BrainBook({
  brief,
  candidates,
  onEdit,
}: {
  brief: OnboardingBrief;
  candidates: OnboardingCandidates;
  onEdit: (index: number, content: string) => void;
}) {
  const [active, setActive] = useState(0);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const item = candidates.brain[Math.min(active, candidates.brain.length - 1)];
  return (
    <div className="ob-brain-book">
      <div className="ob-brain-sidebar">
        <div className="ob-brain-owner">
          <PersonAvatar url={brief.avatarUrl} name={brief.displayName} />
          <span>
            <strong>{brief.displayName.split(" ")[0]}'s Brain</strong>
            <small>Your personal notes</small>
          </span>
        </div>
        <nav aria-label="Your Brain chapters">
          {candidates.brain.map((document, index) => (
            <button
              key={`${document.title}-${index}`}
              type="button"
              aria-current={active === index ? "page" : undefined}
              onClick={() => {
                setActive(index);
                setEditing(false);
              }}
            >
              <span className={`ob-chapter-dot ob-chapter-${document.kind}`} />
              <span>{document.title}</span>
              {active === index && <ArrowUpRight />}
            </button>
          ))}
        </nav>
        <div className="ob-brain-note">
          <Sparkles />
          <p>
            {candidates.personalization?.note ||
              "This is a living picture of you. Add stories and refine it as you grow."}
          </p>
        </div>
      </div>
      <article className="ob-brain-page">
        {candidates.personalization && candidates.personalization.status !== "ready" && (
          <p className="ob-personalization-status" role="status">
            {candidates.personalization.note}
          </p>
        )}
        <div className="ob-document-header">
          <span className="ob-eyebrow">
            Your{" "}
            {item.kind === "profile"
              ? "world"
              : item.kind === "instruction"
                ? "voice"
                : item.kind === "story"
                  ? "stories"
                  : "direction"}
          </span>
          <button
            className="ob-text-link"
            type="button"
            onClick={() => {
              if (editing) {
                onEdit(active, draft);
                setEditing(false);
              } else {
                setDraft(item.content);
                setEditing(true);
              }
            }}
          >
            {editing ? "Save this chapter" : "Edit"}
          </button>
        </div>
        <h2>{item.title}</h2>
        {editing ? (
          <textarea
            aria-label={`Edit ${item.title}`}
            className="ob-document-editor"
            value={draft}
            maxLength={16000}
            onChange={(event) => setDraft(event.target.value)}
          />
        ) : (
          <div
            key={item.title}
            className="ob-document-prose"
            role="region"
            aria-label={`${item.title} full chapter`}
            tabIndex={0}
          >
            <ContentMarkdown text={item.content} />
          </div>
        )}
        {!editing && item.content.length > 900 && (
          <p className="ob-small mt-3">Scroll to keep reading this chapter.</p>
        )}
      </article>
    </div>
  );
}

export function FirstDraft({
  draft,
  brief,
}: {
  draft: OnboardingCandidates["drafts"][number];
  brief: OnboardingBrief;
}) {
  const platform = draft.platform || brief.platform;
  const Icon = onboardingIcons[platform];
  return (
    <article className="ob-first-draft">
      <div className="ob-draft-ribbon">
        <Sparkles />A new idea, in your voice<span>Draft</span>
      </div>
      <div className="ob-post-byline">
        <PersonAvatar url={brief.avatarUrl} name={brief.displayName} />
        <span>
          <strong>{brief.displayName}</strong>
          <small>{providerName(platform)} · ready for your review</small>
        </span>
        <Icon />
      </div>
      <div className="ob-draft-body">{draft.body}</div>
      {draft.mediaPreview && (
        <figure className="ob-draft-photo">
          <img src={draft.mediaPreview.url} alt={draft.mediaPreview.alt} />
          <figcaption>
            {draft.mediaPreview.sourceUrl ? (
              <a href={draft.mediaPreview.sourceUrl} target="_blank" rel="noreferrer">
                Your photo, from Instagram <ArrowUpRight />
              </a>
            ) : (
              "Your connected Instagram photo"
            )}
          </figcaption>
        </figure>
      )}
      {draft.slides?.length ? (
        <div className="ob-draft-slides">
          {draft.slides.map((slide, index) => (
            <div key={index}>
              <small>{String(index + 1).padStart(2, "0")}</small>
              <h3>{slide.heading}</h3>
              <p>{slide.body}</p>
            </div>
          ))}
        </div>
      ) : null}
      {draft.mediaNote && <p className="ob-small px-6 pb-4">{draft.mediaNote}</p>}
      <div className="ob-draft-footnote">
        <Check />
        Saved as a draft. You decide when to publish.
      </div>
    </article>
  );
}

export function RelatedInspiration({ items }: { items: OnboardingEvidence["inspirations"] }) {
  return (
    <div className="ob-inspiration-grid">
      {items.map((item, index) => (
        <a
          key={item.url}
          className={`ob-inspiration ob-inspiration-${index}`}
          href={item.url}
          target="_blank"
          rel="noreferrer"
        >
          <span className="ob-eyebrow">{item.source}</span>
          <h2>{item.title}</h2>
          <p>{item.summary}</p>
          <span className="ob-text-link">
            Read the original <ArrowUpRight />
          </span>
        </a>
      ))}
    </div>
  );
}

export function OnboardingPlanChoices({
  plan,
  period,
  onPlan,
  onPeriod,
}: {
  plan: PaidPlanId;
  period: BillingPeriod;
  onPlan: (plan: PaidPlanId) => void;
  onPeriod: (period: BillingPeriod) => void;
}) {
  const features: Record<PaidPlanId, string[]> = {
    store: [
      "Your page and creator store",
      "Bookings, courses, and communities",
      "0% Bento commission",
    ],
    creator: [
      "Everything in Store",
      "Discover, scheduler, and analytics",
      "Advanced Auto DMs and newsletter",
    ],
    creator_plus: [
      "Everything in Creator",
      "Your personal Brain and AI Agent",
      "Routines and strategy reviews",
    ],
  };
  return (
    <div className="ob-plan-choice-section">
      <div className="ob-plan-choice-heading">
        <span className="ob-eyebrow">Choose your Bento</span>
        <div className="ob-billing-period" role="group" aria-label="Billing period">
          <button
            type="button"
            aria-pressed={period === "monthly"}
            onClick={() => onPeriod("monthly")}
          >
            Monthly
          </button>
          <button
            type="button"
            aria-pressed={period === "yearly"}
            onClick={() => onPeriod("yearly")}
          >
            Yearly <span className="ob-billing-savings">2 months free</span>
          </button>
        </div>
      </div>
      <div className="ob-plan-choices" aria-label="All Bento plans">
        {PAID_PLAN_IDS.map((value) => (
          <button
            key={value}
            type="button"
            className={`ob-plan-choice ob-plan-${value}`}
            aria-label={`${planName(value)} ${PLAN_PRICING[value][period].label}${PLAN_PRICING[value][period].cadence}`}
            aria-pressed={plan === value}
            onClick={() => onPlan(value)}
          >
            <span className="ob-plan-name">
              {planName(value)}
              {plan === value && <CheckCircle2 />}
            </span>
            <span className="ob-plan-price">
              <strong>{PLAN_PRICING[value][period].label}</strong>
              <small>{PLAN_PRICING[value][period].cadence}</small>
            </span>
            <span className="ob-plan-tagline">
              {value === "store"
                ? "Turn your work into a business"
                : value === "creator"
                  ? "Build your publishing rhythm"
                  : "Create with a Brain that knows you"}
            </span>
            <ul>
              {features[value].map((feature) => (
                <li key={feature}>
                  <Check />
                  {feature}
                </li>
              ))}
            </ul>
            <span className="ob-plan-selection">
              {plan === value ? "Selected" : `Choose ${planName(value)}`}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
