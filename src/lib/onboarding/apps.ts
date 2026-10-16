import type { EntitlementKey } from "../plans";
export type GuideStep = { title: string; instruction: string; proof: string };
export type AppGuide = {
  id: string;
  name: string;
  path: string;
  benefit: string;
  entitlement?: EntitlementKey;
  steps: GuideStep[];
};
const step = (title: string, instruction: string, proof: string): GuideStep => ({
  title,
  instruction,
  proof,
});
const social = step(
  "Connect your account",
  "Use Connections below to authorize an account you manage. Reuse your onboarding connection when available.",
  "social",
);
const dmSteps = (provider: string) => [
  step(
    `Connect ${provider}`,
    "Authorize an eligible account using this app’s connection button. Confirm that its messaging permissions are ready.",
    "dm_connection",
  ),
  step(
    "Write one useful reply",
    "Create a rule for one clear keyword and destination. Preview your message. Store supports a basic reply; email and follow gates need Creator.",
    "dm_rule",
  ),
  step(
    "Turn it on when ready",
    "Review the trigger and enable your rule deliberately. Use a separate eligible account to try the keyword; nothing sends until a supported interaction occurs.",
    "dm_enabled",
  ),
];
export const APP_GUIDES: AppGuide[] = [
  {
    id: "home",
    name: "Home",
    path: "/home",
    benefit: "Know what to work on next without opening every app.",
    steps: [
      step(
        "Your starting point",
        "Your page and core Brain arrive here from onboarding. Existing creators can keep their current workspace.",
        "profile",
      ),
      step(
        "Make your page useful",
        "Open Link, check the destinations and publish when you’re ready to share.",
        "published",
      ),
      step(
        "Choose a first offer",
        "Open Store and save an offer draft, or use your content apps to build your audience first.",
        "product",
      ),
    ],
  },
  {
    id: "link",
    name: "Link",
    path: "/link",
    benefit: "Give people one clear place to find, follow and buy from you.",
    steps: [
      step(
        "Start with your identity",
        "Your name and bio are already filled. Edit them in the page header if anything changed.",
        "profile",
      ),
      step(
        "Give visitors a next step",
        "Add a real link or offer using Add block. Preview the destination before sharing.",
        "block",
      ),
      step(
        "Share your page",
        "Publish your prepared page from the onboarding result, then copy your live URL. Your Brain stays private.",
        "published",
      ),
    ],
  },
  {
    id: "store",
    name: "Store",
    path: "/store",
    benefit: "Turn what you know or make into something people can buy, with 0% Bento commission.",
    entitlement: "storeCards",
    steps: [
      step(
        "Draft your first offer",
        "Choose a product type: digital download, course, membership, service, community or another offer. Use your existing description as a starting point.",
        "product",
      ),
      step(
        "Connect payments",
        "Open payment settings below and connect your own payment provider. Review its fees and payout details.",
        "payments",
      ),
      step(
        "Open for business",
        "Set price, delivery and buyer instructions, preview the checkout, then publish the offer when ready.",
        "published_product",
      ),
    ],
  },
  {
    id: "priority_dm",
    name: "Priority DM",
    path: "/priority-dm",
    benefit: "Get paid for thoughtful answers without losing requests in your inbox.",
    entitlement: "storeCards",
    steps: [
      step(
        "Define what you answer",
        "Create a Priority DM offer. Explain what buyers can ask, what they receive and any limits.",
        "priority_draft",
      ),
      step(
        "Connect payments",
        "Reuse the payment provider configured for Store, or connect one before you sell.",
        "payments",
      ),
      step(
        "Set expectations and publish",
        "Choose your price and response window, preview the offer, then publish it. New paid conversations appear here.",
        "priority_live",
      ),
    ],
  },
  {
    id: "calendar",
    name: "Calendar",
    path: "/calendar",
    benefit: "Let clients find a time and book without the back-and-forth.",
    entitlement: "storeCards",
    steps: [
      step(
        "Connect your calendar",
        "Connect Google Calendar to check conflicts and place confirmed bookings.",
        "calendar",
      ),
      step(
        "Protect your time",
        "Review your timezone, weekly availability, notice and buffers. Nothing should be bookable outside the hours you choose.",
        "availability",
      ),
      step(
        "Publish one session",
        "Create a coaching-call offer with a duration, location and price. Preview its booking page before publishing.",
        "booking_live",
      ),
    ],
  },
  {
    id: "community",
    name: "Community",
    path: "/community",
    benefit: "Bring members together around something worth coming back for.",
    entitlement: "storeCards",
    steps: [
      step(
        "Describe the community",
        "Create a community offer with a clear promise, membership terms and price.",
        "community_draft",
      ),
      step(
        "Welcome the first member",
        "Write an introduction explaining where to start and how to take part. Your own words set the tone.",
        "community_post",
      ),
      step(
        "Open membership",
        "Connect payments if needed, review access and publish your community offer.",
        "community_live",
      ),
    ],
  },
  {
    id: "discover",
    name: "Discover",
    path: "/content?tab=discover",
    benefit: "Find relevant ideas with sources, so your next post starts with direction.",
    entitlement: "discover",
    steps: [
      step(
        "Set your direction",
        "Your audience and expertise carry over from onboarding. Review your niche and choose the platform you want to research.",
        "content_profile",
      ),
      step(
        "Explore real sources",
        "Refresh Discover when you’re ready to research. Open a source and judge whether the idea fits your audience.",
        "recommendation",
      ),
      step(
        "Keep one useful idea",
        "Save a recommendation you want to develop. Saving an idea doesn’t change your Brain or publish anything.",
        "saved_recommendation",
      ),
    ],
  },
  {
    id: "scheduler",
    name: "Post Scheduler",
    path: "/post-scheduler",
    benefit: "Prepare a post once and give it a clear place in your week.",
    entitlement: "postScheduler",
    steps: [
      social,
      step(
        "Make a draft your own",
        "Create a post or bring in a starter draft. Review the caption and add media required by the selected network.",
        "social_draft",
      ),
      step(
        "Schedule deliberately",
        "Preview the post, confirm the account and timezone, then choose a time and schedule. A calendar slot alone isn’t a published post.",
        "scheduled",
      ),
    ],
  },
  {
    id: "insights",
    name: "Social Insights",
    path: "/social-insights",
    benefit: "See what your audience responds to and choose your next experiment.",
    entitlement: "socialAnalytics",
    steps: [
      social,
      step(
        "Import what’s available",
        "Use the refresh control for supported networks. New accounts may have little data; Bento won’t invent a performance history.",
        "snapshot",
      ),
      step(
        "Find a useful signal",
        "Open your post results and compare reach or engagement over the same period. Use one real result to guide your next post.",
        "insight",
      ),
    ],
  },
  {
    id: "auto_dms",
    name: "Auto DMs",
    path: "/auto-dms",
    benefit: "Give interested people the right link while the conversation is fresh.",
    steps: [
      step(
        "Pick your network",
        "Open Instagram, Facebook or X below. Each has its own account requirements and setup guide.",
        "social",
      ),
      step(
        "Create a useful rule",
        "Choose one keyword and an honest reply. Nothing is enabled by opening this guide.",
        "any_dm_rule",
      ),
      step(
        "Enable it with intent",
        "Preview the rule in its app, then enable it. Advanced follow and email gates are available on Creator and Creator Plus.",
        "any_dm_enabled",
      ),
    ],
  },
  ...(
    [
      ["instagram", "Instagram"],
      ["facebook", "Facebook"],
      ["twitter", "X"],
    ] as const
  ).map(([provider, name]) => ({
    id: `${provider}_dm`,
    name: `${name} Auto DMs`,
    path: `/auto-dms/${provider}`,
    benefit: "Respond to interest with a helpful, relevant message.",
    steps: dmSteps(name),
  })),
  {
    id: "newsletter",
    name: "Newsletter",
    path: "/email-marketing",
    benefit: "Build a direct relationship with your audience, beyond the social feed.",
    entitlement: "emailMarketing",
    steps: [
      step(
        "Name your publication",
        "Create a publication for the people you want to reach. Reuse your name, audience and offer instead of starting from a blank brief.",
        "publication",
      ),
      step(
        "Write a first issue",
        "Create a newsletter post or broadcast and save a draft. Say who it helps and give readers one useful idea.",
        "issue",
      ),
      step(
        "Publish when ready",
        "Check the website, sender and reply-to settings. Preview your issue and explicitly choose Publish or Send; only send to subscribers who consented.",
        "published_issue",
      ),
    ],
  },
  {
    id: "agent",
    name: "Agent",
    path: "/content?tab=agent",
    benefit: "Turn your context into drafts and decisions you can actually use.",
    entitlement: "contentAgent",
    steps: [
      step(
        "Bring your Brain",
        "Your confirmed identity, voice and strategy are already available to Agent. Open Brain to correct anything first.",
        "brain",
      ),
      step(
        "Start with a saved draft",
        "Open your onboarding conversation, or ask for a draft for one audience and platform. Review any factual claims.",
        "assistant",
      ),
      step(
        "Move it toward publication",
        "Edit a draft card and send it to the scheduler as a draft. Add media and choose a time there when you’re ready.",
        "social_draft",
      ),
    ],
  },
  {
    id: "brain",
    name: "Brain",
    path: "/content?tab=brain",
    benefit: "Explain your business once. Keep the context that makes future help useful.",
    entitlement: "brain",
    steps: [
      step(
        "Confirm who you are",
        "Review My Human: audience, expertise and offer. Correct suggestions that don’t fit your real experience.",
        "brain_profile",
      ),
      step(
        "Keep your own voice",
        "Review writing instructions and examples. Locked, confirmed documents are protected from background suggestions.",
        "brain_voice",
      ),
      step(
        "Choose a workable direction",
        "Review your content strategy, pillars and posting rhythm. A strategy is a plan, not permission to auto-publish.",
        "brain_strategy",
      ),
    ],
  },
  {
    id: "routines",
    name: "Routines",
    path: "/content?tab=agent&routines=true",
    benefit: "Let repeatable preparation happen on a rhythm you control.",
    entitlement: "contentRoutines",
    steps: [
      step(
        "Start from your strategy",
        "Review Brain first so recurring work knows your audience and priorities.",
        "brain",
      ),
      step(
        "Choose one routine",
        "Start with a weekly strategy review. Check timezone, frequency and draft output before enabling it; automatic scheduling is a separate explicit choice.",
        "routine",
      ),
      step(
        "Review the first result",
        "Run it once, then open its real result and make changes. Sparse analytics are a starting point, not evidence of success.",
        "routine_result",
      ),
    ],
  },
  {
    id: "mcp",
    name: "MCP",
    path: "/mcp",
    benefit: "Work on Bento from the AI assistant you already use.",
    entitlement: "mcpSocialAutomation",
    steps: [
      step(
        "Choose your client",
        "Select your client below and copy its setup instructions. Use Bento’s own endpoint and browser authorization.",
        "profile",
      ),
      step(
        "Authorize your workspace",
        "Complete the OAuth flow and check which workspace you authorize. You can revoke access later.",
        "mcp_result",
      ),
      step(
        "Try a safe first request",
        "Ask your connected client to read your Bento profile. Confirm the returned identity before asking it to change, post or send anything.",
        "mcp_result",
      ),
    ],
  },
  {
    id: "earn",
    name: "Earn",
    path: "/earn",
    benefit: "Share something you use and keep track of eligible referral rewards.",
    steps: [
      step(
        "Review the program",
        "Read the live commission, eligibility and payout terms shown below before you share.",
        "profile",
      ),
      step(
        "Get your own link",
        "Use Copy link on this page so referrals use your unique tracking URL.",
        "referral_copied",
      ),
      step(
        "Share with context",
        "Explain who Bento helps and disclose your referral relationship. Rewards appear only after qualifying activity.",
        "referral_copied",
      ),
    ],
  },
  {
    id: "settings",
    name: "Settings",
    path: "/settings",
    benefit: "Keep the details behind your business accurate and easy to manage.",
    steps: [
      step(
        "Check your identity",
        "Review your workspace name and public profile. These details are reused across your apps.",
        "profile",
      ),
      step(
        "Set your timezone",
        "Confirm the account timezone so schedules and reminders use the times you expect.",
        "timezone",
      ),
      step(
        "Know your renewal date",
        "Open Plan to review the selected plan, trial or renewal date, and cancellation controls. Changes require your explicit action.",
        "billing",
      ),
    ],
  },
];
export function appGuideForLocation(
  pathname: string,
  search: { tab?: unknown; routines?: unknown },
) {
  if (pathname === "/content")
    return APP_GUIDES.find(
      (app) =>
        app.id ===
        (search.routines
          ? "routines"
          : search.tab === "brain"
            ? "brain"
            : search.tab === "agent"
              ? "agent"
              : "discover"),
    );
  return [...APP_GUIDES]
    .sort((a, b) => b.path.length - a.path.length)
    .find(
      (app) =>
        !app.path.includes("?") && (pathname === app.path || pathname.startsWith(`${app.path}/`)),
    );
}
