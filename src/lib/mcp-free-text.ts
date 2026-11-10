export type FreeToolKind =
  | "utm"
  | "counter"
  | "formatter"
  | "line-breaker"
  | "bio"
  | "headline"
  | "hooks"
  | "hashtags"
  | "caption"
  | "repurpose"
  | "title"
  | "description"
  | "tags"
  | "thread"
  | "unicode"
  | "thread-splitter"
  | "image-resizer"
  | "image-compressor"
  | "image-flipper"
  | "image-splitter"
  | "background-remover"
  | "media-downloader"
  | "video-downloader"
  | "cover-downloader"
  | "url-transcript"
  | "transcript";

export const aiFreeToolKinds = [
  "bio",
  "headline",
  "hooks",
  "hashtags",
  "caption",
  "repurpose",
  "title",
  "description",
  "tags",
  "thread",
] as const satisfies readonly FreeToolKind[];

export type AiFreeToolKind = (typeof aiFreeToolKinds)[number];

export const freeToolPlatforms = [
  "Instagram",
  "LinkedIn",
  "X",
  "Facebook",
  "Threads",
  "TikTok",
  "YouTube",
  "Reddit",
] as const;

export type FreeToolPlatform = (typeof freeToolPlatforms)[number];

export function isAiFreeToolKind(kind: FreeToolKind): kind is AiFreeToolKind {
  return (aiFreeToolKinds as readonly FreeToolKind[]).includes(kind);
}

export type FreeToolField = {
  key: string;
  label: string;
  placeholder: string;
  multiline?: boolean;
  options?: readonly string[];
};

// Runtime MCP catalog only. Marketing pages, SEO copy, FAQs and guides stay excluded.
export const freeTools: Array<{
  slug: string;
  name: string;
  category: string;
  kind: FreeToolKind;
  description: string;
  fixedPlatform?: FreeToolPlatform;
  counterLimit?: number;
  fields?: FreeToolField[];
}> = [
  {
    slug: "utm-link-builder",
    name: "Free UTM Link Builder",
    category: "Links",
    kind: "utm",
    description:
      "Add clean campaign parameters to any link and know exactly which posts bring people to your page.",
  },
  {
    slug: "social-media-character-counter",
    name: "Social Media Character Counter",
    category: "Measure",
    kind: "counter",
    description:
      "Check characters, words, lines, and the remaining limit before you publish on a social network.",
  },
  {
    slug: "youtube-title-counter",
    name: "YouTube Title Character Counter",
    category: "Measure",
    kind: "counter",
    description:
      "Count a YouTube video title against the 100-character limit before you upload or schedule it.",
    fixedPlatform: "YouTube",
    counterLimit: 100,
  },
  {
    slug: "instagram-bio-counter",
    name: "Instagram Bio Character Counter",
    category: "Measure",
    kind: "counter",
    description:
      "Count an Instagram bio against the 150-character limit while you tighten every line and word.",
    fixedPlatform: "Instagram",
    counterLimit: 150,
  },
  {
    slug: "linkedin-headline-counter",
    name: "LinkedIn Headline Character Counter",
    category: "Measure",
    kind: "counter",
    description:
      "Count a LinkedIn profile headline against the 220-character limit and see the space left in real time.",
    fixedPlatform: "LinkedIn",
    counterLimit: 220,
  },
  {
    slug: "social-post-formatter",
    name: "Free Social Post Formatter",
    category: "Format",
    kind: "formatter",
    description:
      "Clean pasted copy, repair awkward spacing, and turn a rough draft into readable social paragraphs.",
  },
  {
    slug: "instagram-line-break-generator",
    name: "Instagram Line Break Generator",
    category: "Format",
    kind: "line-breaker",
    description:
      "Create tidy Instagram caption spacing that survives copying, pasting, and publishing.",
    fixedPlatform: "Instagram",
  },
  {
    slug: "instagram-bio-generator",
    name: "Free Instagram Bio Generator",
    category: "Write",
    kind: "bio",
    description:
      "Turn what you do, who you help, and your next action into short Instagram bio ideas.",
    fixedPlatform: "Instagram",
    fields: [
      {
        key: "role",
        label: "What do you do?",
        placeholder: "Creator strategist",
      },
      {
        key: "audience",
        label: "Who do you help?",
        placeholder: "Independent creators",
      },
      {
        key: "outcome",
        label: "What result do you create?",
        placeholder: "Build a simple creator business",
      },
      {
        key: "tone",
        label: "Tone",
        placeholder: "Warm",
        options: ["Warm", "Professional", "Playful", "Bold", "Minimal"],
      },
    ],
  },
  {
    slug: "linkedin-headline-generator",
    name: "Free LinkedIn Headline Generator",
    category: "Write",
    kind: "headline",
    description:
      "Write a clear LinkedIn headline around your role, audience, value, and credible proof.",
    fixedPlatform: "LinkedIn",
    fields: [
      {
        key: "role",
        label: "Your role",
        placeholder: "Content strategist",
      },
      {
        key: "audience",
        label: "Who you help",
        placeholder: "B2B founders",
      },
      {
        key: "outcome",
        label: "Result you create",
        placeholder: "Turn expertise into demand",
      },
      {
        key: "tone",
        label: "Tone",
        placeholder: "Professional",
        options: ["Professional", "Confident", "Conversational", "Direct", "Minimal"],
      },
    ],
  },
  {
    slug: "instagram-name-generator",
    name: "Free Instagram Name Generator",
    category: "Write",
    kind: "headline",
    description:
      "Generate ten handle-ready Instagram username ideas around your niche, audience, keywords, and style.",
    fixedPlatform: "Instagram",
    fields: [
      {
        key: "niche",
        label: "Your niche",
        placeholder: "Creator business education",
      },
      {
        key: "audience",
        label: "Who is it for?",
        placeholder: "Independent creators",
      },
      {
        key: "keywords",
        label: "Words you may want included",
        placeholder: "bento, creator, studio",
      },
      {
        key: "style",
        label: "Name style",
        placeholder: "Clean",
        options: ["Clean", "Personal", "Playful", "Bold", "Minimal"],
      },
    ],
  },
  {
    slug: "tiktok-username-generator",
    name: "Free TikTok Username Generator",
    category: "Write",
    kind: "headline",
    description:
      "Generate ten concise TikTok username ideas that fit your niche, content format, keywords, and voice.",
    fixedPlatform: "TikTok",
    fields: [
      {
        key: "niche",
        label: "Your niche",
        placeholder: "Simple home cooking",
      },
      {
        key: "content_type",
        label: "What do you publish?",
        placeholder: "Fast recipe tutorials",
      },
      {
        key: "keywords",
        label: "Words you may want included",
        placeholder: "quick, pan, weeknight",
      },
      {
        key: "style",
        label: "Username style",
        placeholder: "Playful",
        options: ["Clean", "Personal", "Playful", "Bold", "Minimal"],
      },
    ],
  },
  {
    slug: "youtube-channel-name-generator",
    name: "Free YouTube Channel Name Generator",
    category: "Write",
    kind: "headline",
    description:
      "Generate ten clear YouTube channel name ideas around your topic, audience, keywords, and positioning.",
    fixedPlatform: "YouTube",
    fields: [
      {
        key: "topic",
        label: "Channel topic",
        placeholder: "Sustainable solo travel",
      },
      {
        key: "audience",
        label: "Who will watch?",
        placeholder: "First-time solo travellers",
      },
      {
        key: "keywords",
        label: "Words you may want included",
        placeholder: "light, local, routes",
      },
      {
        key: "style",
        label: "Channel name style",
        placeholder: "Memorable",
        options: ["Clear", "Personal", "Memorable", "Expert", "Minimal"],
      },
    ],
  },
  {
    slug: "creator-brand-name-generator",
    name: "Free Creator Brand Name Generator",
    category: "Write",
    kind: "headline",
    description:
      "Generate ten creator-brand name ideas grounded in what you sell, who you help, and what you stand for.",
    fields: [
      {
        key: "business",
        label: "What do you create or sell?",
        placeholder: "Courses and coaching for independent illustrators",
      },
      {
        key: "audience",
        label: "Who is it for?",
        placeholder: "Freelance illustrators",
      },
      {
        key: "values",
        label: "Values or positioning",
        placeholder: "Practical, independent, generous",
      },
      {
        key: "keywords",
        label: "Words you may want included",
        placeholder: "studio, craft, field",
      },
      {
        key: "style",
        label: "Brand name style",
        placeholder: "Distinctive",
        options: ["Clear", "Personal", "Distinctive", "Warm", "Minimal"],
      },
    ],
  },
  {
    slug: "social-media-hook-generator",
    name: "Free Social Media Hook Generator",
    category: "Write",
    kind: "hooks",
    description:
      "Generate direct opening lines for educational, opinion, story, and launch posts without empty hype.",
    fields: [
      {
        key: "topic",
        label: "What is the post about?",
        placeholder: "Building a consistent content system",
        multiline: true,
      },
      {
        key: "audience",
        label: "Who is it for?",
        placeholder: "Busy solo creators",
      },
      {
        key: "style",
        label: "Hook style",
        placeholder: "Curiosity",
        options: ["Curiosity", "Contrarian", "Story", "How-to", "Mistake", "Proof"],
      },
      {
        key: "count",
        label: "Number of hooks",
        placeholder: "5",
        options: ["3", "5", "8", "10"],
      },
    ],
  },
  {
    slug: "hashtag-generator",
    name: "Free Social Media Hashtag Generator",
    category: "Write",
    kind: "hashtags",
    description:
      "Turn a topic and a few keywords into a tidy, relevant hashtag set for your next post.",
    fields: [
      {
        key: "topic",
        label: "Main topic",
        placeholder: "Creator marketing",
      },
      {
        key: "keywords",
        label: "Related keywords",
        placeholder: "content strategy, personal brand, audience growth",
      },
      {
        key: "count",
        label: "Number of hashtags",
        placeholder: "15",
        options: ["10", "15", "20", "25", "30"],
      },
      {
        key: "mix",
        label: "Hashtag mix",
        placeholder: "Balanced",
        options: ["Balanced", "Broad", "Niche", "Community"],
      },
    ],
  },
  {
    slug: "social-media-caption-generator",
    name: "Free Social Media Caption Generator",
    category: "Write",
    kind: "caption",
    description:
      "Build a useful caption from one topic, one takeaway, and one action you want the reader to take.",
    fields: [
      {
        key: "topic",
        label: "Post topic",
        placeholder: "Why creators need a simple publishing system",
      },
      {
        key: "outcome",
        label: "Main takeaway",
        placeholder: "Consistency gets easier when the workflow is visible",
        multiline: true,
      },
      {
        key: "cta",
        label: "Call to action",
        placeholder: "Save this for your next planning day",
      },
      {
        key: "tone",
        label: "Tone",
        placeholder: "Conversational",
        options: ["Conversational", "Educational", "Bold", "Story-led", "Minimal"],
      },
      {
        key: "length",
        label: "Length",
        placeholder: "Medium",
        options: ["Short", "Medium", "Long"],
      },
    ],
  },
  {
    slug: "blog-to-social-post-converter",
    name: "Blog to Social Post Converter",
    category: "Write",
    kind: "repurpose",
    description:
      "Pull a clear social draft from a longer article, newsletter, transcript, or set of notes.",
    fields: [
      {
        key: "source",
        label: "Paste your source text",
        placeholder: "Paste an article, newsletter, transcript, or notes\u2026",
        multiline: true,
      },
      {
        key: "tone",
        label: "Tone",
        placeholder: "Conversational",
        options: ["Conversational", "Educational", "Opinionated", "Story-led", "Minimal"],
      },
    ],
  },
  {
    slug: "youtube-title-generator",
    name: "Free YouTube Title Generator",
    category: "Write",
    kind: "title",
    description:
      "Generate specific YouTube title ideas that make the subject and viewer payoff clear without fake urgency.",
    fixedPlatform: "YouTube",
    fields: [
      {
        key: "topic",
        label: "Video topic",
        placeholder: "How I plan a month of content",
      },
      {
        key: "audience",
        label: "Who is it for?",
        placeholder: "Solo creators",
      },
      {
        key: "outcome",
        label: "Viewer payoff",
        placeholder: "Leave with a repeatable 30-minute workflow",
      },
      {
        key: "keywords",
        label: "Important words",
        placeholder: "content planning, creator workflow",
      },
      {
        key: "tone",
        label: "Title style",
        placeholder: "Clear",
        options: ["Clear", "Curiosity", "How-to", "Contrarian", "Story-led"],
      },
    ],
  },
  {
    slug: "youtube-description-generator",
    name: "Free YouTube Description Generator",
    category: "Write",
    kind: "description",
    description:
      "Turn a video summary into a structured YouTube description with useful context, key points, and a clean next action.",
    fixedPlatform: "YouTube",
    fields: [
      {
        key: "summary",
        label: "What happens in the video?",
        placeholder: "Describe the actual video, its examples, and its conclusion\u2026",
        multiline: true,
      },
      {
        key: "audience",
        label: "Who is it for?",
        placeholder: "Creators building a content system",
      },
      {
        key: "keywords",
        label: "Important keywords",
        placeholder: "content calendar, social scheduler",
      },
      {
        key: "cta",
        label: "Next action",
        placeholder: "Try the free planning template",
      },
      {
        key: "length",
        label: "Description length",
        placeholder: "Medium",
        options: ["Short", "Medium", "Detailed"],
      },
    ],
  },
  {
    slug: "youtube-tags-generator",
    name: "Free YouTube Tags Generator",
    category: "Write",
    kind: "tags",
    description:
      "Create a focused YouTube tag set from the video's real topic, vocabulary, and audience without fake volume claims.",
    fixedPlatform: "YouTube",
    fields: [
      {
        key: "topic",
        label: "Video topic",
        placeholder: "Building a creator content system",
      },
      {
        key: "keywords",
        label: "Related phrases",
        placeholder: "content planning, social scheduling",
      },
      {
        key: "audience",
        label: "Target viewer",
        placeholder: "Independent creators",
      },
      {
        key: "count",
        label: "Number of tags",
        placeholder: "15",
        options: ["10", "15", "20", "25"],
      },
    ],
  },
  {
    slug: "twitter-thread-generator",
    name: "Free X (Twitter) Thread Generator",
    category: "Write",
    kind: "thread",
    description:
      "Break a substantial idea into a coherent X thread where every post advances the argument and fits the standard limit.",
    fixedPlatform: "X",
    fields: [
      {
        key: "source",
        label: "Idea, notes, or source",
        placeholder: "Paste the argument, lesson, or notes the thread must preserve\u2026",
        multiline: true,
      },
      {
        key: "audience",
        label: "Who is it for?",
        placeholder: "Creators building their first product",
      },
      {
        key: "tone",
        label: "Tone",
        placeholder: "Educational",
        options: ["Educational", "Conversational", "Opinionated", "Story-led", "Minimal"],
      },
      {
        key: "count",
        label: "Number of posts",
        placeholder: "7",
        options: ["5", "7", "10"],
      },
    ],
  },
  {
    slug: "transcript-to-social-post",
    name: "Free Transcript to Social Post Converter",
    category: "Write",
    kind: "repurpose",
    description:
      "Turn a podcast, interview, webinar, or voice-note transcript into three platform-ready posts that preserve the source.",
    fields: [
      {
        key: "source",
        label: "Transcript",
        placeholder: "Paste the transcript you own or have permission to repurpose\u2026",
        multiline: true,
      },
      {
        key: "audience",
        label: "Who is it for?",
        placeholder: "Independent creators",
      },
      {
        key: "goal",
        label: "What should the post do?",
        placeholder: "Teach one useful lesson",
      },
      {
        key: "must_keep",
        label: "Point that must stay",
        placeholder: "The exact idea, result, or caveat to preserve",
      },
      {
        key: "tone",
        label: "Tone",
        placeholder: "Conversational",
        options: ["Conversational", "Educational", "Direct", "Story-led", "Minimal"],
      },
      {
        key: "length",
        label: "Post length",
        placeholder: "Medium",
        options: ["Short", "Medium", "Long"],
      },
    ],
  },
  {
    slug: "transcript-to-x-thread",
    name: "Free Transcript to X (Twitter) Thread Converter",
    category: "Write",
    kind: "thread",
    description:
      "Turn a substantial transcript into a coherent X thread where every post preserves the source and fits 280 characters.",
    fixedPlatform: "X",
    fields: [
      {
        key: "source",
        label: "Transcript",
        placeholder: "Paste the transcript or the section the thread must preserve\u2026",
        multiline: true,
      },
      {
        key: "audience",
        label: "Who is it for?",
        placeholder: "Creators building an audience",
      },
      {
        key: "goal",
        label: "Thread goal",
        placeholder: "Explain the five-part framework",
      },
      {
        key: "tone",
        label: "Tone",
        placeholder: "Educational",
        options: ["Educational", "Conversational", "Opinionated", "Story-led", "Minimal"],
      },
      {
        key: "count",
        label: "Number of posts",
        placeholder: "7",
        options: ["5", "7", "10"],
      },
    ],
  },
  {
    slug: "carousel-outline-generator",
    name: "Free Social Media Carousel Outline Generator",
    category: "Write",
    kind: "repurpose",
    description:
      "Plan an ordered five, seven, or ten-slide social carousel with concise copy and a simple visual direction for every slide.",
    fields: [
      {
        key: "topic",
        label: "Topic or source notes",
        placeholder: "Explain the lesson, argument, or process the carousel should teach\u2026",
        multiline: true,
      },
      {
        key: "audience",
        label: "Who is it for?",
        placeholder: "First-time course creators",
      },
      {
        key: "takeaway",
        label: "Main takeaway",
        placeholder: "Start with the learner outcome",
      },
      {
        key: "cta",
        label: "Final action",
        placeholder: "Save this outline for later",
      },
      {
        key: "tone",
        label: "Tone",
        placeholder: "Educational",
        options: ["Educational", "Bold", "Conversational", "Story-led", "Minimal"],
      },
      {
        key: "count",
        label: "Number of slides",
        placeholder: "7",
        options: ["5", "7", "10"],
      },
    ],
  },
  {
    slug: "content-idea-generator",
    name: "Free Social Media Content Idea Generator",
    category: "Write",
    kind: "hooks",
    description:
      "Generate specific content premises for your niche, audience, goal, and chosen social network without fake trend claims.",
    fields: [
      {
        key: "niche",
        label: "Your niche",
        placeholder: "Creator business education",
      },
      {
        key: "audience",
        label: "Who is it for?",
        placeholder: "Creators with a small audience",
      },
      {
        key: "goal",
        label: "Content goal",
        placeholder: "Build trust before a product launch",
      },
      {
        key: "pillars",
        label: "Content pillars",
        placeholder: "Offers, audience, publishing systems",
      },
      {
        key: "format",
        label: "Preferred format",
        placeholder: "Mixed",
        options: ["Mixed", "Educational", "Story", "Opinion", "Behind the scenes", "Case study"],
      },
      {
        key: "count",
        label: "Number of ideas",
        placeholder: "10",
        options: ["5", "10", "15"],
      },
    ],
  },
  {
    slug: "call-to-action-generator",
    name: "Free Social Media Call to Action Generator",
    category: "Write",
    kind: "hooks",
    description:
      "Generate clear, low-hype calls to action around one offer, one audience, and one honest next step.",
    fields: [
      {
        key: "offer",
        label: "Offer or next step",
        placeholder: "A free creator pricing worksheet",
      },
      {
        key: "audience",
        label: "Who is it for?",
        placeholder: "Creators pricing their first product",
      },
      {
        key: "action",
        label: "Action to take",
        placeholder: "Download the worksheet",
      },
      {
        key: "destination",
        label: "Where will they go?",
        placeholder: "The link in my bio",
      },
      {
        key: "tone",
        label: "Tone",
        placeholder: "Direct",
        options: ["Direct", "Warm", "Conversational", "Confident", "Minimal"],
      },
    ],
  },
  {
    slug: "short-form-video-script-generator",
    name: "Free Short-Form Video Script Generator",
    category: "Write",
    kind: "repurpose",
    description:
      "Create a practical short-form video script with a hook, scenes, spoken lines, on-screen text, and one next action.",
    fields: [
      {
        key: "topic",
        label: "Topic or source notes",
        placeholder: "Describe the idea, real example, and points the video must cover\u2026",
        multiline: true,
      },
      {
        key: "audience",
        label: "Who is it for?",
        placeholder: "Creators launching a digital product",
      },
      {
        key: "goal",
        label: "Video goal",
        placeholder: "Teach a three-step pricing check",
      },
      {
        key: "duration",
        label: "Target duration",
        placeholder: "30 seconds",
        options: ["15 seconds", "30 seconds", "45 seconds", "60 seconds"],
      },
      {
        key: "format",
        label: "Video format",
        placeholder: "Talking head",
        options: ["Talking head", "Voice-over", "Tutorial", "Product demo", "Story"],
      },
      {
        key: "tone",
        label: "Tone",
        placeholder: "Conversational",
        options: ["Conversational", "Educational", "Energetic", "Direct", "Minimal"],
      },
      {
        key: "cta",
        label: "Final action",
        placeholder: "Save this before pricing your offer",
      },
    ],
  },
  {
    slug: "social-post-rewriter",
    name: "Free AI Social Media Post Rewriter",
    category: "Write",
    kind: "repurpose",
    description:
      "Rewrite an existing social post for a clearer goal, audience, tone, and platform without changing its underlying facts.",
    fields: [
      {
        key: "source",
        label: "Original post",
        placeholder: "Paste the post you want to improve\u2026",
        multiline: true,
      },
      {
        key: "audience",
        label: "Who is it for?",
        placeholder: "Independent creators",
      },
      {
        key: "goal",
        label: "Rewrite goal",
        placeholder: "Make the lesson easier to understand",
      },
      {
        key: "tone",
        label: "Tone",
        placeholder: "Conversational",
        options: ["Conversational", "Professional", "Bold", "Warm", "Minimal"],
      },
      {
        key: "length",
        label: "Length",
        placeholder: "Similar",
        options: ["Shorter", "Similar", "Longer"],
      },
      {
        key: "constraints",
        label: "What must not change?",
        placeholder: "Keep the link, price, product name, and deadline exact",
      },
    ],
  },
  {
    slug: "social-bold-italic-text",
    name: "Social Media Bold & Italic Text Generator",
    category: "Format",
    kind: "unicode",
    description:
      "Convert plain letters into copyable Unicode bold or italic text for social posts, bios, and headings.",
  },
  {
    slug: "twitter-thread-splitter",
    name: "Free X (Twitter) Thread Splitter",
    category: "Format",
    kind: "thread-splitter",
    description:
      "Split finished copy into numbered X posts at word boundaries while keeping every post within 280 characters.",
    fixedPlatform: "X",
  },
  {
    slug: "social-image-resizer",
    name: "Free Social Media Image Resizer",
    category: "Media",
    kind: "image-resizer",
    description:
      "Resize one image for Instagram, Stories, LinkedIn, X, or YouTube with real crop and contain controls.",
  },
  {
    slug: "image-compressor",
    name: "Free Image Compressor",
    category: "Media",
    kind: "image-compressor",
    description:
      "Compress a JPG, PNG, or WebP into a smaller WebP file with a visible quality control and no upload.",
  },
  {
    slug: "background-remover",
    name: "Free AI Background Remover",
    category: "Media",
    kind: "background-remover",
    description:
      "Remove the background from a JPG, PNG, or WebP and download a transparent PNG without creating an account.",
  },
  {
    slug: "image-flipper",
    name: "Free Image Flipper",
    category: "Media",
    kind: "image-flipper",
    description:
      "Mirror an image horizontally or vertically at its original dimensions, entirely inside your browser.",
  },
  {
    slug: "image-splitter",
    name: "Free Instagram Image Splitter",
    category: "Media",
    kind: "image-splitter",
    description:
      "Slice a wide design into two or three full-height tiles for a swipe carousel or connected profile layout.",
    fixedPlatform: "Instagram",
  },
  {
    slug: "social-media-downloader",
    name: "Free All-in-One Social Media Downloader",
    category: "Media",
    kind: "media-downloader",
    description:
      "Paste a public YouTube, Instagram, TikTok, or X link and download the videos, GIFs, photos, or carousel items Bento can retrieve.",
  },
  {
    slug: "youtube-video-downloader",
    name: "Free YouTube Video Downloader",
    category: "Media",
    kind: "video-downloader",
    description:
      "Paste a public YouTube video or Shorts link and download the video files Bento can securely retrieve for that source.",
    fixedPlatform: "YouTube",
  },
  {
    slug: "instagram-video-downloader",
    name: "Free Instagram Video Downloader",
    category: "Media",
    kind: "video-downloader",
    description:
      "Download available video from a public Instagram Reel or video post using a secure temporary link.",
    fixedPlatform: "Instagram",
  },
  {
    slug: "tiktok-video-downloader",
    name: "Free TikTok Video Downloader",
    category: "Media",
    kind: "video-downloader",
    description:
      "Paste a public TikTok video link and download the video file Bento can securely retrieve for that post.",
    fixedPlatform: "TikTok",
  },
  {
    slug: "twitter-video-downloader",
    name: "Free X (Twitter) Video Downloader",
    category: "Media",
    kind: "video-downloader",
    description:
      "Paste a public X or Twitter post link and download its available native video or animated GIF file.",
    fixedPlatform: "X",
  },
  {
    slug: "instagram-photo-downloader",
    name: "Free Instagram Photo Downloader",
    category: "Media",
    kind: "media-downloader",
    description:
      "Paste a public Instagram photo-post link and download every available image without stretching or recompressing it.",
    fixedPlatform: "Instagram",
  },
  {
    slug: "instagram-carousel-downloader",
    name: "Free Instagram Carousel Downloader",
    category: "Media",
    kind: "media-downloader",
    description:
      "Download the available photos, videos, and mixed slides from one public Instagram carousel in source order.",
    fixedPlatform: "Instagram",
  },
  {
    slug: "tiktok-photo-downloader",
    name: "Free TikTok Photo & Slideshow Downloader",
    category: "Media",
    kind: "media-downloader",
    description:
      "Paste a public TikTok photo-post or slideshow link and download every image Bento can securely retrieve.",
    fixedPlatform: "TikTok",
  },
  {
    slug: "twitter-image-downloader",
    name: "Free X (Twitter) Image Downloader",
    category: "Media",
    kind: "media-downloader",
    description:
      "Paste a public X or Twitter status link and download its available native image or multi-image post files.",
    fixedPlatform: "X",
  },
  {
    slug: "youtube-thumbnail-downloader",
    name: "Free YouTube Thumbnail Downloader",
    category: "Media",
    kind: "cover-downloader",
    description:
      "Paste a public YouTube video or Shorts link and download its available thumbnail image.",
    fixedPlatform: "YouTube",
  },
  {
    slug: "instagram-reel-cover-downloader",
    name: "Free Instagram Reel Cover Downloader",
    category: "Media",
    kind: "cover-downloader",
    description:
      "Paste a public Instagram Reel link and download the cover image Bento can securely retrieve.",
    fixedPlatform: "Instagram",
  },
  {
    slug: "tiktok-cover-downloader",
    name: "Free TikTok Cover Downloader",
    category: "Media",
    kind: "cover-downloader",
    description:
      "Paste a public TikTok video link and download the available cover image for that post.",
    fixedPlatform: "TikTok",
  },
  {
    slug: "youtube-to-transcript",
    name: "Free YouTube video transcript generator",
    category: "Media",
    kind: "url-transcript",
    description:
      "Paste a public YouTube link and turn the spoken audio into a YouTube transcript you can edit. This video transcript generator does not need existing captions.",
    fixedPlatform: "YouTube",
  },
  {
    slug: "instagram-to-transcript",
    name: "Free Instagram Reel Transcript Generator",
    category: "Media",
    kind: "url-transcript",
    description:
      "Convert speech from a public Instagram Reel or video post into editable text and timed captions.",
    fixedPlatform: "Instagram",
  },
  {
    slug: "tiktok-to-transcript",
    name: "Free TikTok Transcript Generator",
    category: "Media",
    kind: "url-transcript",
    description:
      "Turn speech from a public TikTok video into editable text and timed subtitle downloads.",
    fixedPlatform: "TikTok",
  },
  {
    slug: "audio-to-transcript",
    name: "Free Audio to Transcript Converter",
    category: "Media",
    kind: "transcript",
    description:
      "Upload an audio file and turn spoken words into a timestamped transcript you can download as TXT, SRT, or VTT.",
  },
  {
    slug: "instagram-caption-generator",
    name: "Free Instagram Caption Generator",
    category: "Write",
    kind: "caption",
    description:
      "Create readable Instagram captions with a strong first line, natural spacing, and a clear next action.",
    fixedPlatform: "Instagram",
    fields: [
      {
        key: "topic",
        label: "What is the post about?",
        placeholder: "The idea, story, or offer you want to share",
        multiline: true,
      },
      {
        key: "audience",
        label: "Who is it for?",
        placeholder: "Independent creators",
      },
      {
        key: "takeaway",
        label: "Main takeaway",
        placeholder: "What should someone understand or remember?",
      },
      {
        key: "cta",
        label: "Call to action",
        placeholder: "Save this for later",
      },
      {
        key: "tone",
        label: "Tone",
        placeholder: "Conversational",
        options: ["Conversational", "Educational", "Bold", "Story-led", "Minimal"],
      },
      {
        key: "length",
        label: "Length",
        placeholder: "Medium",
        options: ["Short", "Medium", "Long"],
      },
    ],
  },
  {
    slug: "facebook-caption-generator",
    name: "Free Facebook Caption Generator",
    category: "Write",
    kind: "caption",
    description:
      "Turn one idea into a Facebook post that gives enough context, stays conversational, and invites a real response.",
    fixedPlatform: "Facebook",
    fields: [
      {
        key: "topic",
        label: "What is the post about?",
        placeholder: "The idea, story, or offer you want to share",
        multiline: true,
      },
      {
        key: "audience",
        label: "Who is it for?",
        placeholder: "Independent creators",
      },
      {
        key: "takeaway",
        label: "Main takeaway",
        placeholder: "What should someone understand or remember?",
      },
      {
        key: "cta",
        label: "Call to action",
        placeholder: "Save this for later",
      },
      {
        key: "tone",
        label: "Tone",
        placeholder: "Conversational",
        options: ["Conversational", "Educational", "Bold", "Story-led", "Minimal"],
      },
      {
        key: "length",
        label: "Length",
        placeholder: "Medium",
        options: ["Short", "Medium", "Long"],
      },
    ],
  },
  {
    slug: "linkedin-caption-generator",
    name: "Free LinkedIn Post Generator",
    category: "Write",
    kind: "caption",
    description:
      "Shape an expert idea into a clear LinkedIn post without corporate filler, invented proof, or a wall of text.",
    fixedPlatform: "LinkedIn",
    fields: [
      {
        key: "topic",
        label: "What is the post about?",
        placeholder: "The idea, story, or offer you want to share",
        multiline: true,
      },
      {
        key: "audience",
        label: "Who is it for?",
        placeholder: "Independent creators",
      },
      {
        key: "takeaway",
        label: "Main takeaway",
        placeholder: "What should someone understand or remember?",
      },
      {
        key: "cta",
        label: "Call to action",
        placeholder: "Save this for later",
      },
      {
        key: "tone",
        label: "Tone",
        placeholder: "Conversational",
        options: ["Conversational", "Educational", "Bold", "Story-led", "Minimal"],
      },
      {
        key: "length",
        label: "Length",
        placeholder: "Medium",
        options: ["Short", "Medium", "Long"],
      },
    ],
  },
  {
    slug: "twitter-caption-generator",
    name: "Free X (Twitter) Post Generator",
    category: "Write",
    kind: "caption",
    description:
      "Distill an idea into a concise X post that fits the limit and still sounds like a person, not a slogan machine.",
    fixedPlatform: "X",
    fields: [
      {
        key: "topic",
        label: "What is the post about?",
        placeholder: "The idea, story, or offer you want to share",
        multiline: true,
      },
      {
        key: "audience",
        label: "Who is it for?",
        placeholder: "Independent creators",
      },
      {
        key: "takeaway",
        label: "Main takeaway",
        placeholder: "What should someone understand or remember?",
      },
      {
        key: "cta",
        label: "Call to action",
        placeholder: "Save this for later",
      },
      {
        key: "tone",
        label: "Tone",
        placeholder: "Conversational",
        options: ["Conversational", "Educational", "Bold", "Story-led", "Minimal"],
      },
      {
        key: "length",
        label: "Length",
        placeholder: "Medium",
        options: ["Short", "Medium", "Long"],
      },
    ],
  },
  {
    slug: "threads-caption-generator",
    name: "Free Threads Post Generator",
    category: "Write",
    kind: "caption",
    description:
      "Write a conversational Threads post with one clear idea, a natural rhythm, and room for replies.",
    fixedPlatform: "Threads",
    fields: [
      {
        key: "topic",
        label: "What is the post about?",
        placeholder: "The idea, story, or offer you want to share",
        multiline: true,
      },
      {
        key: "audience",
        label: "Who is it for?",
        placeholder: "Independent creators",
      },
      {
        key: "takeaway",
        label: "Main takeaway",
        placeholder: "What should someone understand or remember?",
      },
      {
        key: "cta",
        label: "Call to action",
        placeholder: "Save this for later",
      },
      {
        key: "tone",
        label: "Tone",
        placeholder: "Conversational",
        options: ["Conversational", "Educational", "Bold", "Story-led", "Minimal"],
      },
      {
        key: "length",
        label: "Length",
        placeholder: "Medium",
        options: ["Short", "Medium", "Long"],
      },
    ],
  },
  {
    slug: "tiktok-caption-generator",
    name: "Free TikTok Caption Generator",
    category: "Write",
    kind: "caption",
    description:
      "Create a compact TikTok caption that supports the video, names the takeaway, and uses relevant discovery language.",
    fixedPlatform: "TikTok",
    fields: [
      {
        key: "topic",
        label: "What is the post about?",
        placeholder: "The idea, story, or offer you want to share",
        multiline: true,
      },
      {
        key: "audience",
        label: "Who is it for?",
        placeholder: "Independent creators",
      },
      {
        key: "takeaway",
        label: "Main takeaway",
        placeholder: "What should someone understand or remember?",
      },
      {
        key: "cta",
        label: "Call to action",
        placeholder: "Save this for later",
      },
      {
        key: "tone",
        label: "Tone",
        placeholder: "Conversational",
        options: ["Conversational", "Educational", "Bold", "Story-led", "Minimal"],
      },
      {
        key: "length",
        label: "Length",
        placeholder: "Medium",
        options: ["Short", "Medium", "Long"],
      },
    ],
  },
  {
    slug: "youtube-caption-generator",
    name: "Free YouTube Caption Generator",
    category: "Write",
    kind: "caption",
    description:
      "Write concise supporting copy for a YouTube Short, Community post, or shared video without confusing it with the full description.",
    fixedPlatform: "YouTube",
    fields: [
      {
        key: "topic",
        label: "What is the post about?",
        placeholder: "The idea, story, or offer you want to share",
        multiline: true,
      },
      {
        key: "audience",
        label: "Who is it for?",
        placeholder: "Independent creators",
      },
      {
        key: "takeaway",
        label: "Main takeaway",
        placeholder: "What should someone understand or remember?",
      },
      {
        key: "cta",
        label: "Call to action",
        placeholder: "Save this for later",
      },
      {
        key: "tone",
        label: "Tone",
        placeholder: "Conversational",
        options: ["Conversational", "Educational", "Bold", "Story-led", "Minimal"],
      },
      {
        key: "length",
        label: "Length",
        placeholder: "Medium",
        options: ["Short", "Medium", "Long"],
      },
    ],
  },
  {
    slug: "reddit-caption-generator",
    name: "Free Reddit Post Generator",
    category: "Write",
    kind: "caption",
    description:
      "Turn an idea into a clear Reddit draft with enough context, an honest title angle, and no fake community familiarity.",
    fixedPlatform: "Reddit",
    fields: [
      {
        key: "topic",
        label: "What is the post about?",
        placeholder: "The idea, story, or offer you want to share",
        multiline: true,
      },
      {
        key: "audience",
        label: "Who is it for?",
        placeholder: "Independent creators",
      },
      {
        key: "takeaway",
        label: "Main takeaway",
        placeholder: "What should someone understand or remember?",
      },
      {
        key: "cta",
        label: "Call to action",
        placeholder: "Save this for later",
      },
      {
        key: "tone",
        label: "Tone",
        placeholder: "Conversational",
        options: ["Conversational", "Educational", "Bold", "Story-led", "Minimal"],
      },
      {
        key: "length",
        label: "Length",
        placeholder: "Medium",
        options: ["Short", "Medium", "Long"],
      },
    ],
  },
];
export const freeToolsBySlug = new Map(freeTools.map((tool) => [tool.slug, tool]));
import { splitThreadText, stylizeUnicodeText, type UnicodeTextStyle } from "./free-text-tools";

export const deterministicFreeToolSlugs = [
  "utm-link-builder",
  "social-media-character-counter",
  "youtube-title-counter",
  "instagram-bio-counter",
  "linkedin-headline-counter",
  "social-post-formatter",
  "instagram-line-break-generator",
  "social-bold-italic-text",
  "twitter-thread-splitter",
] as const;

export type DeterministicFreeToolSlug = (typeof deterministicFreeToolSlugs)[number];

export type DeterministicFreeToolInput = {
  toolSlug: DeterministicFreeToolSlug;
  text?: string;
  platform?: FreeToolPlatform;
  style?: UnicodeTextStyle;
  numbered?: boolean;
  url?: string;
  source?: string;
  medium?: string;
  campaign?: string;
  term?: string;
  content?: string;
};

const platformLimits: Record<FreeToolPlatform, number> = {
  Instagram: 2_200,
  LinkedIn: 3_000,
  X: 280,
  Facebook: 63_206,
  Threads: 500,
  TikTok: 4_000,
  YouTube: 5_000,
  Reddit: 40_000,
};

function cleanText(input: string, lineBreaker: boolean) {
  const clean = input
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return lineBreaker ? clean.replace(/\n\n/g, "\n⠀\n") : clean;
}

export function runDeterministicFreeTool(input: DeterministicFreeToolInput) {
  const { toolSlug } = input;
  const tool = freeToolsBySlug.get(toolSlug);
  if (!tool || !deterministicFreeToolSlugs.includes(toolSlug))
    throw new Error("Choose a supported text or link tool.");

  if (toolSlug === "utm-link-builder") {
    const source = input.source?.trim();
    const campaign = input.campaign?.trim();
    if (!source || !campaign) throw new Error("Add a campaign source and campaign name.");
    const raw = input.url?.trim();
    if (!raw) throw new Error("Add a destination URL.");
    let url: URL;
    try {
      url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
      if (!["http:", "https:"].includes(url.protocol)) throw new Error();
    } catch {
      throw new Error("Enter a valid destination URL.");
    }
    for (const key of ["source", "medium", "campaign", "term", "content"] as const) {
      const value = (input[key] ?? (key === "medium" ? "social" : "")).trim();
      if (value) url.searchParams.set(`utm_${key}`, value.toLowerCase().replace(/\s+/g, "-"));
    }
    return { toolSlug, url: url.toString() };
  }

  const text = input.text ?? "";
  if (tool.kind === "counter") {
    const platform = input.platform ?? "Instagram";
    if (!freeToolPlatforms.includes(platform)) throw new Error("Choose a supported platform.");
    const limit = tool.counterLimit ?? platformLimits[platform];
    const characters = Array.from(text).length;
    return {
      toolSlug,
      characters,
      remaining: limit - characters,
      words: text.trim() ? text.trim().split(/\s+/).length : 0,
      lines: text ? text.split(/\r?\n/).length : 0,
      limit,
      platform: tool.counterLimit === undefined ? platform : null,
    };
  }
  if (toolSlug === "social-post-formatter" || toolSlug === "instagram-line-break-generator") {
    return { toolSlug, text: cleanText(text, toolSlug === "instagram-line-break-generator") };
  }
  if (toolSlug === "social-bold-italic-text") {
    const style = input.style ?? "bold";
    if (!["bold", "italic", "bold-italic", "normal"].includes(style))
      throw new Error("Choose a supported text style.");
    return { toolSlug, text: stylizeUnicodeText(text, style) };
  }
  const posts = splitThreadText(text, input.numbered !== false);
  if (posts.length > 99 || posts.some((post) => Array.from(post).length > 280))
    throw new Error("The thread is too long. Use 99 posts or fewer.");
  return { toolSlug, posts };
}
