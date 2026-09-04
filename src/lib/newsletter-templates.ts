import {
  newsletterPublicSlug,
  type NewsletterContentBlock,
  type NewsletterLeafBlock,
} from "./newsletter";

export const NEWSLETTER_TEMPLATE_IDS = [
  "editorial",
  "minimal",
  "bold-digest",
  "product-launch",
  "personal-note",
  "weekly-roundup",
  "visual-story",
  "event-brief",
  "resource-guide",
  "creator-notes",
  "morning-brief",
  "deep-dive",
  "market-pulse",
  "portfolio-journal",
  "product-changelog",
  "case-study",
  "course-lesson",
  "curated-links",
  "city-guide",
  "food-letter",
  "wellness-weekly",
  "book-club",
  "podcast-recap",
  "community-spotlight",
  "research-report",
  "job-board",
  "member-update",
  "seasonal-letter",
] as const;

export type NewsletterTemplateId = (typeof NEWSLETTER_TEMPLATE_IDS)[number];

export type NewsletterTemplatePresentation = {
  accentColor: string;
  backgroundColor: string;
  canvasColor?: string;
  headingStyle: "serif" | "sans";
  density: "compact" | "comfortable";
  contentWidth?: 560 | 600 | 640 | 680;
};

type WithoutId<Block> = Block extends unknown ? Omit<Block, "id"> : never;
type StarterLeafBlock = WithoutId<NewsletterLeafBlock>;
type StarterBlock =
  | StarterLeafBlock
  | (Omit<Extract<NewsletterContentBlock, { type: "section" }>, "id" | "columns"> & {
      columns: [StarterLeafBlock[], StarterLeafBlock[]];
    });

export type NewsletterTemplate = {
  id: NewsletterTemplateId;
  name: string;
  category: "Editorial" | "Business" | "Community" | "Personal";
  description: string;
  subject: string;
  previewText: string;
  isDefault: boolean;
  presentation: NewsletterTemplatePresentation;
  content: StarterBlock[];
};

const LONG_TEMPLATE_BLUEPRINTS: Array<{
  id: NewsletterTemplateId;
  name: string;
  category: NewsletterTemplate["category"];
  description: string;
  subject: string;
  previewText: string;
  accent: string;
  background: string;
  canvas: string;
  image: string;
  headline: string;
  intro: string;
  quote: string;
  items: [string, string, string];
  cta: string;
  variant: number;
}> = [
  {
    id: "morning-brief",
    name: "Morning Brief",
    category: "Editorial",
    description: "A crisp daily briefing with a hero story, signals, and quick links.",
    subject: "Your morning brief",
    previewText: "The stories and signals to start your day.",
    accent: "#e4572e",
    background: "#fffaf4",
    canvas: "#efe7dc",
    image: "/branding/bento-logo.png",
    headline: "Good morning: here is what matters",
    intro:
      "Start with the one development your readers should understand before the day gets noisy.",
    quote: "Clarity is a competitive advantage before 9am.",
    items: ["The lead story in two minutes", "A number worth watching", "One useful link"],
    cta: "Read the full briefing",
    variant: 0,
  },
  {
    id: "deep-dive",
    name: "Sunday Deep Dive",
    category: "Editorial",
    description: "A spacious long-read with context, evidence, and a considered conclusion.",
    subject: "This week’s deep dive",
    previewText: "One subject, properly unpacked.",
    accent: "#264653",
    background: "#f7fbfa",
    canvas: "#dce7e5",
    image: "/branding/bento-logo.png",
    headline: "The story behind the story",
    intro:
      "Set the scene, name the tension, and give the reader a reason to stay for the full argument.",
    quote: "Good analysis changes what the reader notices next.",
    items: ["What happened", "Why it matters", "What comes next"],
    cta: "Continue the analysis",
    variant: 1,
  },
  {
    id: "market-pulse",
    name: "Market Pulse",
    category: "Business",
    description: "A data-led market update with signals, commentary, and a sharp takeaway.",
    subject: "The market pulse",
    previewText: "Numbers moved. Here is the useful context.",
    accent: "#006d77",
    background: "#f3fbfb",
    canvas: "#cfe5e6",
    image: "/branding/bento-logo.png",
    headline: "This week in the market",
    intro:
      "Lead with the movement, then explain the forces underneath it without making readers decode a dashboard.",
    quote: "The trend matters more than a single noisy point.",
    items: ["Demand signal", "Competitive move", "Risk to monitor"],
    cta: "See the full report",
    variant: 2,
  },
  {
    id: "portfolio-journal",
    name: "Portfolio Journal",
    category: "Personal",
    description: "An image-led creative journal for projects, process, and reflection.",
    subject: "Inside the studio",
    previewText: "New work and the process behind it.",
    accent: "#9b5de5",
    background: "#fcf9ff",
    canvas: "#eadff5",
    image: "/branding/bento-logo.png",
    headline: "What I made this month",
    intro: "Use the opening to connect the work to the question or obsession that shaped it.",
    quote: "Process is part of the work, not a footnote.",
    items: ["A finished piece", "A work in progress", "A lesson to carry forward"],
    cta: "View the portfolio",
    variant: 3,
  },
  {
    id: "product-changelog",
    name: "Product Changelog",
    category: "Business",
    description: "A polished release note with screenshots, benefits, and next steps.",
    subject: "What is new in the product",
    previewText: "A faster workflow and three useful improvements.",
    accent: "#3a86ff",
    background: "#f6f9ff",
    canvas: "#dce8fb",
    image: "/branding/bento-logo.png",
    headline: "A better way to get the job done",
    intro: "Explain the customer problem first, then show exactly what changed in the product.",
    quote: "Small workflow improvements compound every day.",
    items: ["Faster setup", "Clearer controls", "More reliable output"],
    cta: "Try the new release",
    variant: 4,
  },
  {
    id: "case-study",
    name: "Customer Case Study",
    category: "Business",
    description: "A proof-driven customer story with challenge, approach, and results.",
    subject: "How one customer changed the result",
    previewText: "The challenge, the work, and the measurable outcome.",
    accent: "#2a9d8f",
    background: "#f5fcfa",
    canvas: "#d7ece7",
    image: "/branding/bento-logo.png",
    headline: "From friction to a repeatable result",
    intro:
      "Introduce the customer in their own context, then make the before-and-after easy to understand.",
    quote: "We finally have a workflow the whole team can trust.",
    items: ["Challenge", "Approach", "Result"],
    cta: "Read the customer story",
    variant: 5,
  },
  {
    id: "course-lesson",
    name: "Course Lesson",
    category: "Business",
    description: "A teachable lesson with an example, exercise, and clear next step.",
    subject: "Lesson one: build the foundation",
    previewText: "A practical idea you can use today.",
    accent: "#ff7b00",
    background: "#fffaf2",
    canvas: "#f2dfc7",
    image: "/branding/bento-logo.png",
    headline: "Learn one useful thing",
    intro:
      "State the outcome, teach the core idea, and keep the exercise close to the explanation.",
    quote: "Learning sticks when the reader does something with it.",
    items: ["Read the concept", "Study the example", "Complete the exercise"],
    cta: "Open the lesson",
    variant: 0,
  },
  {
    id: "curated-links",
    name: "Curated Links",
    category: "Editorial",
    description: "A generous collection of reads, tools, and recommendations with context.",
    subject: "Things worth your attention",
    previewText: "Five links, each with a reason to click.",
    accent: "#5f0f40",
    background: "#fff8fc",
    canvas: "#eedce8",
    image: "/branding/bento-logo.png",
    headline: "The internet, edited down",
    intro:
      "Tell readers the theme connecting this edition before walking through the recommendations.",
    quote: "Curation is judgment made visible.",
    items: ["A long read", "A practical tool", "An unexpected idea"],
    cta: "Browse every recommendation",
    variant: 1,
  },
  {
    id: "city-guide",
    name: "City Guide",
    category: "Editorial",
    description: "A visual local guide with places, routes, and an editor’s pick.",
    subject: "A local guide to the weekend",
    previewText: "Where to go, what to order, and what not to miss.",
    accent: "#0077b6",
    background: "#f5fbff",
    canvas: "#d9eaf3",
    image: "/branding/bento-logo.png",
    headline: "A weekend well spent",
    intro:
      "Open with a sense of place, then organize the guide around moments rather than a flat directory.",
    quote: "The best places make a city feel personal.",
    items: ["Morning coffee", "An afternoon walk", "Dinner worth booking"],
    cta: "Save the full guide",
    variant: 2,
  },
  {
    id: "food-letter",
    name: "Food Letter",
    category: "Personal",
    description: "A warm recipe letter with a hero dish, notes, and serving ideas.",
    subject: "What I am cooking this week",
    previewText: "One recipe, a few notes, and a good table.",
    accent: "#bc6c25",
    background: "#fffaf3",
    canvas: "#eadbc8",
    image: "/branding/bento-logo.png",
    headline: "A recipe worth repeating",
    intro:
      "Bring readers into the kitchen with the story, then keep the method simple enough to follow.",
    quote: "Good food is memory you can make again.",
    items: ["The ingredient that matters", "The technique to watch", "What to serve beside it"],
    cta: "Get the full recipe",
    variant: 3,
  },
  {
    id: "wellness-weekly",
    name: "Wellness Weekly",
    category: "Personal",
    description: "A calm weekly check-in with one practice, one resource, and reflection.",
    subject: "A quieter week starts here",
    previewText: "One practice for more energy and less noise.",
    accent: "#588157",
    background: "#f8fbf6",
    canvas: "#dde8d8",
    image: "/branding/bento-logo.png",
    headline: "Make space for what restores you",
    intro:
      "Meet the reader where they are and offer one realistic practice rather than an impossible routine.",
    quote: "Consistency can be gentle.",
    items: ["A five-minute practice", "A helpful read", "A question to reflect on"],
    cta: "Try this week’s practice",
    variant: 4,
  },
  {
    id: "book-club",
    name: "Book Club",
    category: "Community",
    description: "A reader-friendly book club edition with themes, quotes, and discussion prompts.",
    subject: "This month’s book club",
    previewText: "The big idea and three questions for our conversation.",
    accent: "#6d597a",
    background: "#fcf9fd",
    canvas: "#e6ddeb",
    image: "/branding/bento-logo.png",
    headline: "Let’s talk about the book",
    intro:
      "Summarize the central tension without spoiling the experience, then invite readers into the discussion.",
    quote: "A great book keeps changing after the last page.",
    items: ["A theme to notice", "A passage to revisit", "A question for the group"],
    cta: "Join the discussion",
    variant: 5,
  },
  {
    id: "podcast-recap",
    name: "Podcast Recap",
    category: "Editorial",
    description: "An episode companion with key moments, quotes, and listening links.",
    subject: "New episode: the ideas that stayed with us",
    previewText: "Highlights, timestamps, and the full conversation.",
    accent: "#ef476f",
    background: "#fff8fa",
    canvas: "#f1dce2",
    image: "/branding/bento-logo.png",
    headline: "Inside the latest conversation",
    intro: "Introduce the guest and the question that made this conversation worth recording.",
    quote: "The useful answer usually begins after the obvious one.",
    items: ["The opening argument", "A surprising example", "The practical takeaway"],
    cta: "Listen to the episode",
    variant: 0,
  },
  {
    id: "community-spotlight",
    name: "Community Spotlight",
    category: "Community",
    description: "A celebratory member profile with a project, lessons, and ways to connect.",
    subject: "Meet someone doing remarkable work",
    previewText: "A community story worth knowing.",
    accent: "#118ab2",
    background: "#f4fbfd",
    canvas: "#d8eaf0",
    image: "/branding/bento-logo.png",
    headline: "Meet this month’s member",
    intro:
      "Show the person behind the work, then make their path useful to readers at a similar stage.",
    quote: "Community becomes real when people can see one another.",
    items: ["What they are building", "What they learned", "How to connect"],
    cta: "Read the full spotlight",
    variant: 1,
  },
  {
    id: "research-report",
    name: "Research Report",
    category: "Business",
    description: "An executive research summary with findings, implications, and methodology.",
    subject: "New research: what the data says",
    previewText: "Three findings and what they mean for your work.",
    accent: "#073b4c",
    background: "#f4f9fa",
    canvas: "#d5e2e5",
    image: "/branding/bento-logo.png",
    headline: "The findings at a glance",
    intro:
      "Lead with the decision the research can improve, then show the evidence in a scannable sequence.",
    quote: "Evidence is useful when it changes a decision.",
    items: ["Finding one", "Finding two", "Finding three"],
    cta: "Download the report",
    variant: 2,
  },
  {
    id: "job-board",
    name: "Curated Job Board",
    category: "Community",
    description: "A focused opportunity digest with featured roles and application advice.",
    subject: "Fresh opportunities for this week",
    previewText: "Selected roles, useful context, and one hiring tip.",
    accent: "#4361ee",
    background: "#f6f8ff",
    canvas: "#dde3f6",
    image: "/branding/bento-logo.png",
    headline: "Work worth applying for",
    intro:
      "Explain how the roles were selected so readers trust the list and know who each opportunity suits.",
    quote: "A smaller, better list saves everyone time.",
    items: ["Featured role", "Remote opportunity", "Early-stage team"],
    cta: "Browse every role",
    variant: 3,
  },
  {
    id: "member-update",
    name: "Member Update",
    category: "Community",
    description: "A structured membership update with wins, decisions, and upcoming dates.",
    subject: "Your member update",
    previewText: "What changed, what is next, and where to join in.",
    accent: "#8338ec",
    background: "#fbf7ff",
    canvas: "#e9dcf5",
    image: "/branding/bento-logo.png",
    headline: "What is happening in the community",
    intro:
      "Start with the most important decision or milestone, then give members clear ways to participate.",
    quote: "Healthy communities make progress visible.",
    items: ["A member win", "An important decision", "An upcoming event"],
    cta: "Open the member hub",
    variant: 4,
  },
  {
    id: "seasonal-letter",
    name: "Seasonal Letter",
    category: "Personal",
    description: "A reflective quarterly letter with images, highlights, and what comes next.",
    subject: "A note for the new season",
    previewText: "What changed, what stayed, and what I am carrying forward.",
    accent: "#a44a3f",
    background: "#fff9f6",
    canvas: "#ecdeda",
    image: "/branding/bento-logo.png",
    headline: "Notes from the turning season",
    intro:
      "Use a personal scene to open the letter, then connect it to the work and ideas that shaped the quarter.",
    quote: "A season is long enough to notice what is changing.",
    items: ["A moment to remember", "A lesson from the work", "An intention for next season"],
    cta: "Read the full letter",
    variant: 5,
  },
];

function buildLongTemplate(
  blueprint: (typeof LONG_TEMPLATE_BLUEPRINTS)[number],
): NewsletterTemplate {
  const section: StarterBlock = {
    type: "section",
    layout: (["two-equal", "two-left", "two-right"] as const)[blueprint.variant % 3],
    style: { backgroundColor: blueprint.canvas, padding: 22, borderRadius: 14 },
    columns: [
      [
        { type: "heading", text: blueprint.items[0] },
        { type: "paragraph", text: blueprint.items[1] },
      ],
      [
        { type: "quote", text: blueprint.quote },
        { type: "paragraph", text: blueprint.items[2] },
      ],
    ],
  };
  const image: StarterBlock = {
    type: "image",
    url: blueprint.image,
    alt: blueprint.headline,
    caption: "Feature image",
  };
  const list: StarterBlock = { type: "list", items: [...blueprint.items] };
  const groups: StarterBlock[][] = [
    [
      { type: "heading", text: blueprint.headline },
      image,
      { type: "paragraph", text: blueprint.intro },
      section,
      list,
    ],
    [
      { type: "heading", text: blueprint.headline },
      { type: "paragraph", text: blueprint.intro },
      { type: "quote", text: blueprint.quote },
      image,
      section,
    ],
    [
      { type: "heading", text: blueprint.headline },
      section,
      image,
      { type: "paragraph", text: blueprint.intro },
      list,
    ],
    [
      image,
      { type: "heading", text: blueprint.headline },
      { type: "paragraph", text: blueprint.intro },
      list,
      section,
    ],
    [
      { type: "heading", text: blueprint.headline },
      list,
      { type: "paragraph", text: blueprint.intro },
      image,
      section,
    ],
    [
      { type: "heading", text: blueprint.headline },
      { type: "quote", text: blueprint.quote },
      section,
      { type: "paragraph", text: blueprint.intro },
      image,
    ],
  ];
  return {
    id: blueprint.id,
    name: blueprint.name,
    category: blueprint.category,
    description: blueprint.description,
    subject: blueprint.subject,
    previewText: blueprint.previewText,
    isDefault: false,
    presentation: {
      accentColor: blueprint.accent,
      backgroundColor: blueprint.background,
      canvasColor: blueprint.canvas,
      headingStyle: blueprint.variant % 2 ? "serif" : "sans",
      density: blueprint.variant % 3 ? "comfortable" : "compact",
      contentWidth: ([560, 600, 640, 680] as const)[blueprint.variant % 4],
    },
    content: [
      ...groups[blueprint.variant % groups.length],
      { type: "divider" },
      { type: "heading", text: "Take this with you" },
      {
        type: "paragraph",
        text: "Close with a useful summary and a clear reason to return for the next edition.",
      },
      { type: "button", label: blueprint.cta, url: "/" },
      { type: "social", label: "Share this edition", url: "/" },
    ],
  };
}

export const NEWSLETTER_TEMPLATES: NewsletterTemplate[] = [
  {
    id: "editorial",
    name: "Classic Editorial",
    category: "Editorial",
    description: "A lead story with a supporting column and a considered close.",
    subject: "The story worth your time",
    previewText: "One idea, thoughtfully unpacked.",
    isDefault: true,
    presentation: {
      accentColor: "#3478f6",
      backgroundColor: "#f6f7fa",
      canvasColor: "#ece8de",
      headingStyle: "serif",
      density: "comfortable",
      contentWidth: 640,
    },
    content: [
      { type: "heading", text: "THE WEEKLY EDIT" },
      { type: "paragraph", text: "Ideas, observations, and useful things for curious people." },
      {
        type: "section",
        layout: "two-left",
        style: { backgroundColor: "#f2eee4", padding: 24, borderRadius: 4 },
        columns: [
          [
            { type: "heading", text: "The main story" },
            {
              type: "paragraph",
              text: "Open with the idea your readers should remember, then give it room to breathe.",
            },
            { type: "button", label: "Continue reading", url: "/" },
          ],
          [{ type: "quote", text: "A sharp point of view makes the story memorable." }],
        ],
      },
      { type: "divider" },
      { type: "paragraph", text: "Close with the detail that brings readers back next week." },
    ],
  },
  {
    id: "minimal",
    name: "Minimal Note",
    category: "Personal",
    description: "A clean, personal letter with generous space and one action.",
    subject: "A quick note from me",
    previewText: "Something I wanted to share with you.",
    isDefault: false,
    presentation: {
      accentColor: "#17213a",
      backgroundColor: "#ffffff",
      canvasColor: "#f3f4f6",
      headingStyle: "sans",
      density: "comfortable",
      contentWidth: 560,
    },
    content: [
      { type: "paragraph", text: "Hi there," },
      { type: "heading", text: "A thought worth sharing" },
      {
        type: "paragraph",
        text: "Write as if you are speaking to one reader. Tell them what changed and why it matters.",
      },
      { type: "quote", text: "Keep the useful part. Remove the rest." },
      { type: "paragraph", text: "Thanks for being here.\n\nYour name" },
      { type: "button", label: "Write back", url: "/", variant: "link" },
    ],
  },
  {
    id: "bold-digest",
    name: "Weekly Digest",
    category: "Editorial",
    description: "A punchy scan of stories, links, and quick takes.",
    subject: "The digest: what matters now",
    previewText: "Five useful things for your week.",
    isDefault: false,
    presentation: {
      accentColor: "#e5484d",
      backgroundColor: "#fff6f5",
      canvasColor: "#e8edff",
      headingStyle: "sans",
      density: "compact",
      contentWidth: 680,
    },
    content: [
      { type: "heading", text: "THE SIGNAL" },
      { type: "paragraph", text: "Practical plays, shipped fast." },
      {
        type: "list",
        ordered: true,
        items: ["The biggest update", "One useful link", "A sharp takeaway"],
      },
      { type: "divider" },
      { type: "heading", text: "Worth opening" },
      { type: "list", items: ["A story to save", "A tool to try", "An idea to share"] },
      { type: "social", label: "Join the conversation", url: "/" },
    ],
  },
  {
    id: "product-launch",
    name: "Product Drop",
    category: "Business",
    description: "A bold launch story with benefits, proof, and a focused CTA.",
    subject: "Introducing something new",
    previewText: "Built for the people who asked first.",
    isDefault: false,
    presentation: {
      accentColor: "#7c3aed",
      backgroundColor: "#f8f5ff",
      canvasColor: "#3c1713",
      headingStyle: "sans",
      density: "comfortable",
      contentWidth: 640,
    },
    content: [
      { type: "heading", text: "It is here." },
      { type: "paragraph", text: "A better way to get the result your customers care about." },
      {
        type: "section",
        layout: "two-equal",
        style: { backgroundColor: "#ffe2d9", padding: 24, borderRadius: 18 },
        columns: [
          [{ type: "list", items: ["Faster setup", "Clearer workflow", "A better result"] }],
          [{ type: "quote", text: "The launch our early users kept asking for." }],
        ],
      },
      { type: "button", label: "Explore the launch", url: "/store" },
      { type: "divider" },
      { type: "paragraph", text: "Questions? Reply and tell us what you are building." },
    ],
  },
  {
    id: "personal-note",
    name: "Founder Letter",
    category: "Personal",
    description: "A direct founder update with a lesson and personal sign-off.",
    subject: "What I learned building this",
    previewText: "The honest version of this week.",
    isDefault: false,
    presentation: {
      accentColor: "#b45309",
      backgroundColor: "#fffaf0",
      canvasColor: "#eee3d1",
      headingStyle: "serif",
      density: "comfortable",
      contentWidth: 600,
    },
    content: [
      { type: "heading", text: "A letter from the founder" },
      { type: "spacer", height: 24 },
      {
        type: "paragraph",
        text: "This week did not go exactly to plan. That made the lesson clearer.",
      },
      { type: "quote", text: "Progress usually looks obvious only after the fact." },
      { type: "paragraph", text: "Here is what changed, what worked, and what I will do next." },
      { type: "divider" },
      { type: "paragraph", text: "Until next week,\nYour name" },
    ],
  },
  {
    id: "weekly-roundup",
    name: "Community Pulse",
    category: "Community",
    description: "Colorful community updates, events, and member highlights.",
    subject: "What is happening in the community",
    previewText: "New faces, useful events, and this week's wins.",
    isDefault: false,
    presentation: {
      accentColor: "#168566",
      backgroundColor: "#f1fbf7",
      canvasColor: "#efe5fb",
      headingStyle: "sans",
      density: "compact",
      contentWidth: 680,
    },
    content: [
      { type: "heading", text: "This week in the community" },
      {
        type: "section",
        layout: "two-equal",
        columns: [
          [
            { type: "heading", text: "Member wins" },
            { type: "paragraph", text: "Celebrate a launch, milestone, or generous contribution." },
          ],
          [
            { type: "heading", text: "Coming up" },
            { type: "paragraph", text: "Share the next event and why readers should join." },
          ],
        ],
      },
      { type: "spacer", height: 16 },
      { type: "list", items: ["One introduction", "One event", "One useful resource"] },
      { type: "button", label: "Join the next event", url: "/" },
    ],
  },
  {
    id: "visual-story",
    name: "Visual Story",
    category: "Editorial",
    description: "An image-led feature for portfolios, travel, and visual reporting.",
    subject: "A story told in pictures",
    previewText: "A visual journey with a useful takeaway.",
    isDefault: false,
    presentation: {
      accentColor: "#12645b",
      backgroundColor: "#f4fbf9",
      canvasColor: "#dfeeea",
      headingStyle: "serif",
      density: "comfortable",
      contentWidth: 680,
    },
    content: [
      { type: "heading", text: "Inside the story" },
      {
        type: "image",
        url: "/branding/bento-logo.png",
        alt: "Featured visual",
        caption: "Set the scene with one strong image.",
      },
      {
        type: "paragraph",
        text: "Use the opening paragraph to give the image context and meaning.",
      },
      { type: "quote", text: "The best visual stories leave space for the reader." },
      { type: "button", label: "View the full collection", url: "/" },
    ],
  },
  {
    id: "event-brief",
    name: "Event Brief",
    category: "Community",
    description: "An event invitation with agenda, speaker note, and registration CTA.",
    subject: "You are invited",
    previewText: "The agenda, the people, and how to join.",
    isDefault: false,
    presentation: {
      accentColor: "#9e2b58",
      backgroundColor: "#fff6fa",
      canvasColor: "#f2dbe5",
      headingStyle: "sans",
      density: "comfortable",
      contentWidth: 640,
    },
    content: [
      { type: "heading", text: "Save the date" },
      {
        type: "paragraph",
        text: "A focused session for people who care about doing the work well.",
      },
      {
        type: "section",
        layout: "two-right",
        columns: [
          [{ type: "list", ordered: true, items: ["Welcome", "Main session", "Questions"] }],
          [
            {
              type: "quote",
              text: "Leave with one idea you can use immediately.",
              attribution: "Your host",
            },
          ],
        ],
      },
      { type: "button", label: "Reserve your place", url: "/" },
    ],
  },
  {
    id: "resource-guide",
    name: "Resource Guide",
    category: "Business",
    description: "A practical collection of tools, reading, and downloadable resources.",
    subject: "The resource guide to save",
    previewText: "Useful tools and reading, organized for you.",
    isDefault: false,
    presentation: {
      accentColor: "#087443",
      backgroundColor: "#f6fff9",
      canvasColor: "#d9f0e2",
      headingStyle: "sans",
      density: "compact",
      contentWidth: 680,
    },
    content: [
      { type: "heading", text: "The practical resource guide" },
      {
        type: "section",
        layout: "two-left",
        columns: [
          [
            { type: "heading", text: "Start here" },
            { type: "list", items: ["Foundational guide", "Quick checklist", "Reference library"] },
          ],
          [
            { type: "heading", text: "Go deeper" },
            {
              type: "list",
              items: ["Expert interview", "Detailed teardown", "Community discussion"],
            },
          ],
        ],
      },
      { type: "divider" },
      {
        type: "paragraph",
        text: "Bookmark this email and return whenever you need the next step.",
      },
      { type: "button", label: "Download the guide", url: "/" },
    ],
  },
  {
    id: "creator-notes",
    name: "Creator Notes",
    category: "Personal",
    description: "Short observations, recommendations, and a conversational close.",
    subject: "Notes from this week",
    previewText: "What I noticed, saved, and recommend.",
    isDefault: false,
    presentation: {
      accentColor: "#d42c68",
      backgroundColor: "#fff9fb",
      canvasColor: "#f3e7ec",
      headingStyle: "serif",
      density: "compact",
      contentWidth: 600,
    },
    content: [
      { type: "heading", text: "A few notes" },
      {
        type: "paragraph",
        text: "One observation from the week, written while it is still fresh.",
      },
      { type: "quote", text: "The small detail is usually the interesting one." },
      { type: "spacer", height: 32 },
      { type: "list", items: ["Something I read", "Something I tried", "Something I recommend"] },
      { type: "social", label: "Reply with your recommendation", url: "/" },
      { type: "divider" },
    ],
  },
  ...LONG_TEMPLATE_BLUEPRINTS.map(buildLongTemplate),
];

export function getNewsletterTemplate(id: NewsletterTemplateId) {
  return NEWSLETTER_TEMPLATES.find((template) => template.id === id)!;
}

export function resolveNewsletterTemplate(id: unknown) {
  return typeof id === "string"
    ? (NEWSLETTER_TEMPLATES.find((template) => template.id === id) ?? null)
    : null;
}

function addTemplateBlockIds(block: StarterBlock): NewsletterContentBlock {
  if (block.type !== "section") return { ...block, id: crypto.randomUUID() } as NewsletterLeafBlock;
  return {
    ...block,
    id: crypto.randomUUID(),
    columns: block.columns.map((column) =>
      column.map((child) => ({ ...child, id: crypto.randomUUID() }) as NewsletterLeafBlock),
    ) as [NewsletterLeafBlock[], NewsletterLeafBlock[]],
  };
}

export function createTemplatePostContent(id: NewsletterTemplateId): NewsletterContentBlock[] {
  const template = getNewsletterTemplate(id);
  const starter = [...template.content];
  if (!starter.some((block) => block.type === "image")) {
    starter.splice(1, 0, {
      type: "image",
      url:
        template.category === "Business"
          ? "/branding/bento-logo.png"
          : template.category === "Community"
            ? "/branding/bento-logo.png"
            : "/branding/bento-logo.png",
      alt: `${template.name} feature image`,
      caption: "Replace this image with your own.",
    });
  }
  if (starter.length < 9) {
    starter.push(
      { type: "divider" },
      { type: "heading", text: "One more thing" },
      {
        type: "paragraph",
        text: "Add a useful closing thought, a recommendation, or a clear reason to return next time.",
      },
      { type: "button", label: "Continue reading", url: "/" },
    );
  }
  return starter.map(addTemplateBlockIds);
}

export function uniqueTemplatePostIdentity(
  requestedName: string,
  posts: Array<{ name: string; publicSlug?: string | null; public_slug?: string | null }>,
) {
  const baseName = requestedName.trim() || "Untitled post";
  const occupiedNames = new Set(posts.map((post) => post.name.trim().toLowerCase()));
  const occupiedSlugs = new Set(
    posts
      .map((post) => post.publicSlug ?? post.public_slug)
      .filter((slug): slug is string => Boolean(slug)),
  );

  let suffix = 1;
  while (true) {
    const name = suffix === 1 ? baseName : `${baseName} ${suffix}`;
    const publicSlug = newsletterPublicSlug(name) || "post";
    if (!occupiedNames.has(name.toLowerCase()) && !occupiedSlugs.has(publicSlug)) {
      return { name, publicSlug };
    }
    suffix += 1;
  }
}
