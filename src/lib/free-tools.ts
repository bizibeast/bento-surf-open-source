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

export type FreeTool = {
  slug: string;
  name: string;
  shortName: string;
  description: string;
  category: "Write" | "Format" | "Measure" | "Links" | "Media";
  kind: FreeToolKind;
  fixedPlatform?: FreeToolPlatform;
  counterLimit?: number;
  counterLabel?: string;
  seoTitle: string;
  seoDescription: string;
  fields?: FreeToolField[];
  howItWorks: [string, string, string];
  tips: string[];
  faqs: { question: string; answer: string }[];
  relatedSlugs: string[];
  guides?: ReadonlyArray<{ slug: string; label: string }>;
};

const platformCaptionFields: FreeToolField[] = [
  {
    key: "topic",
    label: "What is the post about?",
    placeholder: "The idea, story, or offer you want to share",
    multiline: true,
  },
  { key: "audience", label: "Who is it for?", placeholder: "Independent creators" },
  {
    key: "takeaway",
    label: "Main takeaway",
    placeholder: "What should someone understand or remember?",
  },
  { key: "cta", label: "Call to action", placeholder: "Save this for later" },
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
];

const platformCaptionTools: FreeTool[] = [
  {
    slug: "instagram-caption-generator",
    name: "Free Instagram Caption Generator",
    shortName: "Instagram captions",
    description:
      "Create readable Instagram captions with a strong first line, natural spacing, and a clear next action.",
    category: "Write",
    kind: "caption",
    fixedPlatform: "Instagram",
    seoTitle: "Free AI Instagram Caption Generator | bento.surf",
    seoDescription:
      "Generate original Instagram caption ideas with a chosen tone, length, takeaway, and call to action. Free and no sign-up required.",
    fields: platformCaptionFields,
    howItWorks: ["Describe the post", "Choose tone and length", "Edit and copy a caption"],
    tips: [
      "Put the clearest promise or tension before Instagram truncates the caption.",
      "Use short paragraphs so the caption scans comfortably on a phone.",
      "Keep hashtags relevant and separate from the main idea when readability matters.",
    ],
    faqs: [
      {
        question: "What makes a useful Instagram caption?",
        answer:
          "A useful caption earns the next line quickly, adds context the visual cannot carry alone, and ends with one natural action instead of several competing asks.",
      },
      {
        question: "Will the generator invent personal stories or results?",
        answer:
          "It is instructed to use only the details you provide. Review every draft and add your own real examples before publishing.",
      },
    ],
    relatedSlugs: [
      "instagram-bio-generator",
      "hashtag-generator",
      "instagram-line-break-generator",
    ],
  },
  {
    slug: "facebook-caption-generator",
    name: "Free Facebook Caption Generator",
    shortName: "Facebook captions",
    description:
      "Turn one idea into a Facebook post that gives enough context, stays conversational, and invites a real response.",
    category: "Write",
    kind: "caption",
    fixedPlatform: "Facebook",
    seoTitle: "Free AI Facebook Caption Generator | bento.surf",
    seoDescription:
      "Generate clear Facebook post captions for creator updates, stories, offers, and community conversations. Free and no sign-up required.",
    fields: platformCaptionFields,
    howItWorks: ["Describe the update", "Choose tone and length", "Edit and copy the post"],
    tips: [
      "Give enough context for someone who has not seen your earlier posts.",
      "Use a specific question when the goal is conversation.",
      "Avoid turning every update into a sales pitch.",
    ],
    faqs: [
      {
        question: "Can it write Facebook group posts?",
        answer:
          "Yes. Describe the group and the discussion you want to start, then choose a conversational or educational tone.",
      },
      {
        question: "Does it know facts about my business?",
        answer:
          "Only the facts you enter are available to the generator. Add exact offer details and verify the final post before publishing.",
      },
    ],
    relatedSlugs: ["social-media-hook-generator", "hashtag-generator", "social-post-formatter"],
  },
  {
    slug: "linkedin-caption-generator",
    name: "Free LinkedIn Post Generator",
    shortName: "LinkedIn posts",
    description:
      "Shape an expert idea into a clear LinkedIn post without corporate filler, invented proof, or a wall of text.",
    category: "Write",
    kind: "caption",
    fixedPlatform: "LinkedIn",
    seoTitle: "Free AI LinkedIn Post Generator | bento.surf",
    seoDescription:
      "Generate clear LinkedIn post drafts for insights, founder stories, lessons, and launches. Choose tone and length with no sign-up.",
    fields: platformCaptionFields,
    howItWorks: ["Add your professional insight", "Set tone and length", "Edit and copy the post"],
    tips: [
      "Lead with the insight, not a long setup about why you are posting.",
      "Use concrete experience you can defend instead of generic authority claims.",
      "Break longer posts into short paragraphs for feed scanning.",
    ],
    faqs: [
      {
        question: "How is this different from a generic caption generator?",
        answer:
          "The prompt favors plain-language professional insight, restrained formatting, and LinkedIn's longer post structure instead of copying an Instagram caption style.",
      },
      {
        question: "Can it write in my personal voice?",
        answer:
          "Choose the closest tone and provide a specific takeaway. The best result still needs your real example and a final voice edit.",
      },
    ],
    relatedSlugs: [
      "linkedin-headline-generator",
      "social-media-hook-generator",
      "social-post-formatter",
    ],
  },
  {
    slug: "twitter-caption-generator",
    name: "Free X (Twitter) Post Generator",
    shortName: "X posts",
    description:
      "Distill an idea into a concise X post that fits the limit and still sounds like a person, not a slogan machine.",
    category: "Write",
    kind: "caption",
    fixedPlatform: "X",
    seoTitle: "Free AI Twitter Post Generator for X | bento.surf",
    seoDescription:
      "Generate concise X (Twitter) post drafts that fit 280 characters. Choose an angle and tone, then edit and copy for free.",
    fields: platformCaptionFields,
    howItWorks: ["Describe one focused idea", "Choose the tone", "Copy a post under the limit"],
    tips: [
      "Make one claim per post; use a thread when the idea needs real context.",
      "Spend characters on specificity instead of introductory filler.",
      "Check names, numbers, and links before posting.",
    ],
    faqs: [
      {
        question: "Will every result fit X's standard character limit?",
        answer:
          "The server validates each generated result against 280 Unicode characters before returning it.",
      },
      {
        question: "Why does the URL use Twitter?",
        answer:
          "Many people still search for Twitter post tools. The page clearly labels the current network as X (Twitter) and creates content for the current product.",
      },
    ],
    relatedSlugs: [
      "twitter-thread-generator",
      "social-media-character-counter",
      "twitter-video-downloader",
    ],
  },
  {
    slug: "threads-caption-generator",
    name: "Free Threads Post Generator",
    shortName: "Threads posts",
    description:
      "Write a conversational Threads post with one clear idea, a natural rhythm, and room for replies.",
    category: "Write",
    kind: "caption",
    fixedPlatform: "Threads",
    seoTitle: "Free AI Threads Post Generator | bento.surf",
    seoDescription:
      "Generate conversational Threads post drafts within the platform limit. Pick a tone and length, then edit and copy for free.",
    fields: platformCaptionFields,
    howItWorks: ["Add one conversation idea", "Choose the tone", "Edit and copy the post"],
    tips: [
      "Write like a useful conversation starter, not a recycled press release.",
      "Use the first post for the complete core thought.",
      "Ask for replies only when the question is specific enough to answer.",
    ],
    faqs: [
      {
        question: "Does it create a Threads chain?",
        answer:
          "This tool creates one complete post within the standard limit. Use the thread generator when the idea needs multiple connected posts.",
      },
      {
        question: "Can I reuse an Instagram caption here?",
        answer:
          "You can provide the same idea, but Threads usually reads better with a shorter, more conversational structure and fewer decorative hashtags.",
      },
    ],
    relatedSlugs: [
      "social-media-hook-generator",
      "social-media-character-counter",
      "social-post-formatter",
    ],
  },
  {
    slug: "tiktok-caption-generator",
    name: "Free TikTok Caption Generator",
    shortName: "TikTok captions",
    description:
      "Create a compact TikTok caption that supports the video, names the takeaway, and uses relevant discovery language.",
    category: "Write",
    kind: "caption",
    fixedPlatform: "TikTok",
    seoTitle: "Free AI TikTok Caption Generator | bento.surf",
    seoDescription:
      "Generate TikTok caption ideas for tutorials, stories, launches, and creator videos. Choose tone and length with no sign-up.",
    fields: platformCaptionFields,
    howItWorks: ["Describe the video", "Add its takeaway", "Edit and copy the caption"],
    tips: [
      "Let the caption add context instead of narrating every visible moment.",
      "Use searchable words that accurately describe the video.",
      "Keep the call to action easy to complete from a phone.",
    ],
    faqs: [
      {
        question: "Does this generate trending TikTok hashtags?",
        answer:
          "No. It can suggest relevant language from your topic, but it does not claim live trend or search-volume data.",
      },
      {
        question: "Should the caption repeat the on-screen hook?",
        answer:
          "Usually it is more useful to reinforce the promise or add context. Repetition can work when the phrase is central and short.",
      },
    ],
    relatedSlugs: [
      "hashtag-generator",
      "social-media-hook-generator",
      "social-media-character-counter",
    ],
  },
  {
    slug: "youtube-caption-generator",
    name: "Free YouTube Caption Generator",
    shortName: "YouTube captions",
    description:
      "Write concise supporting copy for a YouTube Short, Community post, or shared video without confusing it with the full description.",
    category: "Write",
    kind: "caption",
    fixedPlatform: "YouTube",
    seoTitle: "Free AI YouTube Caption Generator | bento.surf",
    seoDescription:
      "Generate YouTube Short and Community post captions with a clear hook, takeaway, and call to action. Free and no sign-up.",
    fields: platformCaptionFields,
    howItWorks: [
      "Describe the video or update",
      "Choose tone and length",
      "Edit and copy the caption",
    ],
    tips: [
      "Use the description generator for long-form metadata and links.",
      "Make the caption understandable without relying on clickbait.",
      "Name the useful outcome early for Shorts viewers.",
    ],
    faqs: [
      {
        question: "Is this the same as a YouTube description generator?",
        answer:
          "No. This creates shorter supporting copy for Shorts or Community posts. The description tool creates structured long-form video metadata.",
      },
      {
        question: "Can it watch my video?",
        answer:
          "Not in this release. It writes from the details you provide, so include the actual subject and takeaway and verify the result.",
      },
    ],
    relatedSlugs: [
      "youtube-description-generator",
      "youtube-title-generator",
      "youtube-tags-generator",
    ],
  },
  {
    slug: "reddit-caption-generator",
    name: "Free Reddit Post Generator",
    shortName: "Reddit posts",
    description:
      "Turn an idea into a clear Reddit draft with enough context, an honest title angle, and no fake community familiarity.",
    category: "Write",
    kind: "caption",
    fixedPlatform: "Reddit",
    seoTitle: "Free AI Reddit Post Generator | bento.surf",
    seoDescription:
      "Generate a useful Reddit post draft from your topic, audience, and takeaway. Keep it contextual, editable, and free to use.",
    fields: platformCaptionFields,
    howItWorks: ["Describe the post context", "Choose the tone", "Edit for the subreddit"],
    tips: [
      "Read the target subreddit's rules before posting.",
      "Disclose your relationship when mentioning your own product.",
      "Add concrete context before asking the community for feedback.",
    ],
    faqs: [
      {
        question: "Does the generator know each subreddit's rules?",
        answer:
          "No. Rules and norms change by community. Treat the draft as a starting point and review the target subreddit before publishing.",
      },
      {
        question: "Can it make promotional copy look organic?",
        answer:
          "It is designed for clear, honest drafts, not disguised promotion. State your relationship and contribute useful context.",
      },
    ],
    relatedSlugs: [
      "social-media-hook-generator",
      "social-post-formatter",
      "social-media-character-counter",
    ],
  },
];

export const freeTools: FreeTool[] = [
  {
    slug: "utm-link-builder",
    name: "Free UTM Link Builder",
    shortName: "UTM link builder",
    description:
      "Add clean campaign parameters to any link and know exactly which posts bring people to your page.",
    category: "Links",
    kind: "utm",
    seoTitle: "Free UTM Link Builder for Social Media | bento.surf",
    seoDescription:
      "Build a trackable UTM campaign URL for Instagram, LinkedIn, X, Facebook, email, and other channels. Free, instant, and no sign-up required.",
    howItWorks: [
      "Paste your destination URL",
      "Name the source and campaign",
      "Copy the trackable link",
    ],
    tips: [
      "Use lowercase names so reports stay tidy.",
      "Keep one campaign name across every channel you compare.",
      "Change source and medium for each placement, not the destination page.",
    ],
    faqs: [
      {
        question: "What is a UTM link?",
        answer:
          "It is a normal URL with campaign parameters that analytics tools can use to identify where a visit came from.",
      },
      {
        question: "Does Bento store the links I create?",
        answer: "No. This builder runs in your browser and does not save the values you enter.",
      },
    ],
    relatedSlugs: [
      "social-media-character-counter",
      "social-media-caption-generator",
      "hashtag-generator",
    ],
  },
  {
    slug: "social-media-character-counter",
    name: "Social Media Character Counter",
    shortName: "Character counter",
    description:
      "Check characters, words, lines, and the remaining limit before you publish on a social network.",
    category: "Measure",
    kind: "counter",
    seoTitle: "Free Social Media Character Counter | bento.surf",
    seoDescription:
      "Count characters, words, and lines for Instagram, LinkedIn, X, Facebook, Threads, TikTok, and YouTube before you publish.",
    howItWorks: ["Choose a social network", "Write or paste your post", "Check the live limit"],
    tips: [
      "Treat the limit as a ceiling, not a target.",
      "Put the most important idea before text is truncated in the feed.",
      "Preview the final post inside the network when formatting is critical.",
    ],
    faqs: [
      {
        question: "Are spaces and emoji counted?",
        answer:
          "Yes. The total includes spaces and emoji, matching the practical length of the text you paste.",
      },
      {
        question: "Why can a platform count some emoji differently?",
        answer:
          "Some networks count combined emoji and special characters with provider-specific rules. This tool counts visible Unicode characters as a helpful pre-publish check.",
      },
    ],
    relatedSlugs: [
      "social-post-formatter",
      "instagram-line-break-generator",
      "social-media-hook-generator",
    ],
  },
  {
    slug: "youtube-title-counter",
    name: "YouTube Title Character Counter",
    shortName: "YouTube title counter",
    description:
      "Count a YouTube video title against the 100-character limit before you upload or schedule it.",
    category: "Measure",
    kind: "counter",
    fixedPlatform: "YouTube",
    counterLimit: 100,
    counterLabel: "YouTube title",
    seoTitle: "YouTube Title Character Counter: Check the 100 Limit | Bento",
    seoDescription:
      "Check your YouTube title against the 100-character limit as you type and see how many characters remain before you upload. Free, private, no sign-up.",
    howItWorks: [
      "Paste your video title",
      "Check the live 100-character count",
      "Edit before publishing",
    ],
    tips: [
      "Put the specific topic and viewer payoff early enough to scan on small screens.",
      "Do not spend the full limit on repeated keywords or empty urgency.",
      "Preview the title beside your thumbnail before publishing.",
    ],
    faqs: [
      {
        question: "What is the YouTube video title limit?",
        answer:
          "YouTube video titles allow up to 100 characters. This counter shows your current count and the number remaining.",
      },
      {
        question: "Does this tool save my title?",
        answer: "No. Counting happens in your browser and Bento does not save the text you enter.",
      },
    ],
    relatedSlugs: [
      "youtube-title-generator",
      "youtube-description-generator",
      "youtube-tags-generator",
    ],
  },
  {
    slug: "instagram-bio-counter",
    name: "Instagram Bio Character Counter",
    shortName: "Instagram bio counter",
    description:
      "Count an Instagram bio against the 150-character limit while you tighten every line and word.",
    category: "Measure",
    kind: "counter",
    fixedPlatform: "Instagram",
    counterLimit: 150,
    counterLabel: "Instagram bio",
    seoTitle: "Free Instagram Bio Character Counter | bento.surf",
    seoDescription:
      "Count characters, words, and lines in an Instagram bio, with a live 150-character limit guide. Free and no sign-up required.",
    howItWorks: [
      "Paste your Instagram bio",
      "Check the live 150-character count",
      "Edit until it fits",
    ],
    tips: [
      "Lead with what you do or who you help instead of a vague introduction.",
      "Keep line breaks only when they make the bio easier to scan.",
      "Leave room for one clear next step when your profile needs it.",
    ],
    faqs: [
      {
        question: "What is the Instagram bio limit?",
        answer:
          "Instagram bios allow up to 150 characters. This counter includes spaces and line breaks in the live total.",
      },
      {
        question: "Does this counter rewrite my bio?",
        answer:
          "No. It only measures the text in your browser. Use the Instagram bio generator when you want editable AI ideas.",
      },
    ],
    relatedSlugs: [
      "instagram-bio-generator",
      "instagram-line-break-generator",
      "instagram-name-generator",
    ],
  },
  {
    slug: "linkedin-headline-counter",
    name: "LinkedIn Headline Character Counter",
    shortName: "LinkedIn headline counter",
    description:
      "Count a LinkedIn profile headline against the 220-character limit and see the space left in real time.",
    category: "Measure",
    kind: "counter",
    fixedPlatform: "LinkedIn",
    counterLimit: 220,
    counterLabel: "LinkedIn headline",
    seoTitle: "Free LinkedIn Headline Character Counter | bento.surf",
    seoDescription:
      "Count every character in a LinkedIn profile headline and see how many remain out of 220. Free, instant, and no sign-up required.",
    howItWorks: [
      "Paste your LinkedIn headline",
      "Check the live 220-character count",
      "Edit before saving",
    ],
    tips: [
      "Put searchable expertise and the audience you help before decorative wording.",
      "Use separators only when the headline still reads as one clear thought.",
      "A shorter specific headline is usually clearer than filling every character.",
    ],
    faqs: [
      {
        question: "What is the LinkedIn profile headline limit?",
        answer:
          "LinkedIn profile headlines allow up to 220 characters. This counter shows your total and remaining space as you type.",
      },
      {
        question: "Does this check how my headline appears in search?",
        answer:
          "It checks length only. Search and mobile surfaces may truncate visible text, so keep the most important language near the beginning.",
      },
    ],
    relatedSlugs: [
      "linkedin-headline-generator",
      "social-media-character-counter",
      "social-post-rewriter",
    ],
  },
  {
    slug: "social-post-formatter",
    name: "Free Social Post Formatter",
    shortName: "Social post formatter",
    description:
      "Clean pasted copy, repair awkward spacing, and turn a rough draft into readable social paragraphs.",
    category: "Format",
    kind: "formatter",
    seoTitle: "Free Social Media Post Formatter | bento.surf",
    seoDescription:
      "Format social media posts with clean paragraphs, consistent spacing, and readable line breaks for Instagram, LinkedIn, X, Facebook, and Threads.",
    howItWorks: ["Paste your rough draft", "Clean its spacing", "Copy the formatted post"],
    tips: [
      "Use one idea per paragraph.",
      "Keep the opening line easy to understand without context.",
      "End with one clear next action instead of several competing asks.",
    ],
    faqs: [
      {
        question: "What does the formatter change?",
        answer:
          "It trims accidental spaces, removes excessive blank lines, and keeps intentional paragraphs readable.",
      },
      {
        question: "Will it change my words?",
        answer: "No. It cleans spacing and line breaks without rewriting your message.",
      },
    ],
    relatedSlugs: [
      "instagram-line-break-generator",
      "social-media-character-counter",
      "social-bold-italic-text",
    ],
  },
  {
    slug: "instagram-line-break-generator",
    name: "Instagram Line Break Generator",
    shortName: "Instagram line breaks",
    description:
      "Create tidy Instagram caption spacing that survives copying, pasting, and publishing.",
    category: "Format",
    kind: "line-breaker",
    fixedPlatform: "Instagram",
    seoTitle: "Free Instagram Line Break Generator | bento.surf",
    seoDescription:
      "Add reliable line breaks to Instagram captions and bios. Format your copy free in the browser without dots, symbols, or sign-up.",
    howItWorks: ["Paste your caption", "Preserve the paragraph breaks", "Copy it into Instagram"],
    tips: [
      "Avoid spaces at the end of a paragraph.",
      "Keep hashtags in a separate final section when readability matters.",
      "Check the caption once after pasting into Instagram.",
    ],
    faqs: [
      {
        question: "How are the line breaks preserved?",
        answer:
          "The formatter places an invisible spacing character on otherwise empty lines so the paragraphs remain separated when pasted.",
      },
      {
        question: "Can I use it for an Instagram bio?",
        answer: "Yes. Short multi-line bios can use the same formatting method.",
      },
    ],
    relatedSlugs: ["instagram-bio-generator", "social-post-formatter", "hashtag-generator"],
  },
  {
    slug: "instagram-bio-generator",
    name: "Free Instagram Bio Generator",
    shortName: "Instagram bio generator",
    description:
      "Turn what you do, who you help, and your next action into short Instagram bio ideas.",
    category: "Write",
    kind: "bio",
    fixedPlatform: "Instagram",
    seoTitle: "Free Instagram Bio Generator for Creators | bento.surf",
    seoDescription:
      "Generate concise Instagram bio ideas for creators, coaches, freelancers, and small businesses. Free, instant, and no sign-up required.",
    fields: [
      { key: "role", label: "What do you do?", placeholder: "Creator strategist" },
      { key: "audience", label: "Who do you help?", placeholder: "Independent creators" },
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
    howItWorks: [
      "Describe your work",
      "Add your audience and outcome",
      "Choose a bio and make it yours",
    ],
    tips: [
      "Say who the account is for.",
      "Use proof only when it is specific and true.",
      "Make the final line point to one useful link or action.",
    ],
    faqs: [
      {
        question: "Does this use AI?",
        answer:
          "Yes. Bento sends only the details you enter to a server-side AI model and returns editable bio ideas. Your API key is never exposed in the browser.",
      },
      {
        question: "How long should an Instagram bio be?",
        answer:
          "Keep it concise enough to scan in a few seconds. Instagram currently allows up to 150 characters in the bio field.",
      },
    ],
    relatedSlugs: [
      "instagram-line-break-generator",
      "social-media-hook-generator",
      "hashtag-generator",
    ],
  },
  {
    slug: "linkedin-headline-generator",
    name: "Free LinkedIn Headline Generator",
    shortName: "LinkedIn headline generator",
    description:
      "Write a clear LinkedIn headline around your role, audience, value, and credible proof.",
    category: "Write",
    kind: "headline",
    fixedPlatform: "LinkedIn",
    seoTitle: "Free LinkedIn Headline Generator | bento.surf",
    seoDescription:
      "Generate clear LinkedIn headline ideas for creators, founders, coaches, freelancers, and professionals. Free and no sign-up required.",
    fields: [
      { key: "role", label: "Your role", placeholder: "Content strategist" },
      { key: "audience", label: "Who you help", placeholder: "B2B founders" },
      { key: "outcome", label: "Result you create", placeholder: "Turn expertise into demand" },
      {
        key: "tone",
        label: "Tone",
        placeholder: "Professional",
        options: ["Professional", "Confident", "Conversational", "Direct", "Minimal"],
      },
    ],
    howItWorks: ["Enter your role", "Describe who you help", "Pick the clearest headline"],
    tips: [
      "Lead with words your ideal client would search.",
      "Prefer a clear outcome over a list of buzzwords.",
      "Use separators sparingly so the headline still reads like one thought.",
    ],
    faqs: [
      {
        question: "What makes a good LinkedIn headline?",
        answer:
          "A useful headline makes your role, audience, and value obvious without making the reader decode a list of vague claims.",
      },
      {
        question: "Can I edit the generated options?",
        answer: "Yes. The options are starting points and can be copied, shortened, or combined.",
      },
    ],
    relatedSlugs: [
      "social-media-hook-generator",
      "social-media-caption-generator",
      "linkedin-headline-counter",
    ],
  },
  {
    slug: "instagram-name-generator",
    name: "Free Instagram Name Generator",
    shortName: "Instagram name generator",
    description:
      "Generate ten handle-ready Instagram username ideas around your niche, audience, keywords, and style.",
    category: "Write",
    kind: "headline",
    fixedPlatform: "Instagram",
    seoTitle: "Instagram Username Generator: Free AI Name Ideas | Bento",
    seoDescription:
      "Get 10 Instagram username ideas based on your niche, audience, keywords, and style. Built for creators, coaches, and brands. Free, editable, no sign-up.",
    fields: [
      { key: "niche", label: "Your niche", placeholder: "Creator business education" },
      { key: "audience", label: "Who is it for?", placeholder: "Independent creators" },
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
    howItWorks: ["Describe your niche", "Add useful words and style", "Verify a name you like"],
    tips: [
      "Choose a name people can hear once and type without explanation.",
      "Avoid extra punctuation when a cleaner version still communicates the idea.",
      "Check the username, trademark, and domain yourself before building a brand around it.",
    ],
    faqs: [
      {
        question: "Does Bento check whether an Instagram name is available?",
        answer:
          "No. These are creative suggestions, not availability results. Bento does not check Instagram usernames; verify every option directly on Instagram.",
      },
      {
        question: "Does Bento check trademarks or legal conflicts?",
        answer:
          "No. Bento does not search trademark databases, business registries, domains, or legal conflicts. Do your own checks before adopting a name.",
      },
    ],
    relatedSlugs: [
      "instagram-bio-generator",
      "instagram-bio-counter",
      "creator-brand-name-generator",
    ],
  },
  {
    slug: "tiktok-username-generator",
    name: "Free TikTok Username Generator",
    shortName: "TikTok username generator",
    description:
      "Generate ten concise TikTok username ideas that fit your niche, content format, keywords, and voice.",
    category: "Write",
    kind: "headline",
    fixedPlatform: "TikTok",
    seoTitle: "Free AI TikTok Username Generator | bento.surf",
    seoDescription:
      "Generate ten TikTok username ideas for a creator or brand from your niche, content format, keywords, and preferred style.",
    fields: [
      { key: "niche", label: "Your niche", placeholder: "Simple home cooking" },
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
    howItWorks: [
      "Describe your content",
      "Choose a username style",
      "Verify a suggestion on TikTok",
    ],
    tips: [
      "Prefer a handle someone can spell after hearing it in a video.",
      "Keep the core name usable on other networks when possible.",
      "Verify username availability and trademark risk independently before committing.",
    ],
    faqs: [
      {
        question: "Are the suggested TikTok usernames available?",
        answer:
          "Bento does not check live TikTok username availability. The tool generates ideas only, so verify each suggestion in TikTok before using it.",
      },
      {
        question: "Does the generator check trademarks or domains?",
        answer:
          "No. It does not check trademarks, business names, domains, or legal conflicts. Those checks remain your responsibility.",
      },
    ],
    relatedSlugs: [
      "tiktok-caption-generator",
      "short-form-video-script-generator",
      "creator-brand-name-generator",
    ],
  },
  {
    slug: "youtube-channel-name-generator",
    name: "Free YouTube Channel Name Generator",
    shortName: "YouTube channel names",
    description:
      "Generate ten clear YouTube channel name ideas around your topic, audience, keywords, and positioning.",
    category: "Write",
    kind: "headline",
    fixedPlatform: "YouTube",
    seoTitle: "YouTube Channel Name Generator: Free AI Name Ideas | Bento",
    seoDescription:
      "Get 10 YouTube channel name ideas from your topic, audience, keywords, and style. Choose clear, personal, memorable, or expert names. Free, no sign-up.",
    fields: [
      { key: "topic", label: "Channel topic", placeholder: "Sustainable solo travel" },
      { key: "audience", label: "Who will watch?", placeholder: "First-time solo travellers" },
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
    howItWorks: ["Describe your channel", "Choose its naming style", "Verify the strongest option"],
    tips: [
      "Make the subject or point of view understandable without a long explanation.",
      "Say each option aloud and check how it looks beside a thumbnail.",
      "Check the channel name, handle, trademark, and domain separately before launch.",
    ],
    faqs: [
      {
        question: "Does Bento check YouTube channel or handle availability?",
        answer:
          "No. The names are creative suggestions only. Bento does not check YouTube channel names or handles, so verify them directly on YouTube.",
      },
      {
        question: "Are trademark and domain checks included?",
        answer:
          "No. Bento does not check trademarks, domains, business registries, or legal conflicts. Verify the option independently before adopting it.",
      },
    ],
    relatedSlugs: [
      "youtube-title-generator",
      "youtube-title-counter",
      "creator-brand-name-generator",
    ],
  },
  {
    slug: "creator-brand-name-generator",
    name: "Free Creator Brand Name Generator",
    shortName: "Creator brand names",
    description:
      "Generate ten creator-brand name ideas grounded in what you sell, who you help, and what you stand for.",
    category: "Write",
    kind: "headline",
    seoTitle: "Free AI Creator Brand Name Generator | bento.surf",
    seoDescription:
      "Generate ten creator business and personal brand name ideas from your offer, audience, values, keywords, and preferred style.",
    fields: [
      {
        key: "business",
        label: "What do you create or sell?",
        placeholder: "Courses and coaching for independent illustrators",
      },
      { key: "audience", label: "Who is it for?", placeholder: "Freelance illustrators" },
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
    howItWorks: [
      "Describe your creator business",
      "Add its values and style",
      "Research a name before using it",
    ],
    tips: [
      "Choose a name broad enough for the work you plan to grow into.",
      "Test pronunciation, spelling, and how it reads as a URL or social handle.",
      "Research trademarks, domains, company names, and platform handles independently.",
    ],
    faqs: [
      {
        question: "Does Bento verify that a brand name is safe to use?",
        answer:
          "No. Suggestions are not legal clearance. Bento does not check trademarks, company registries, domains, usernames, or other conflicts.",
      },
      {
        question: "Are matching domains and social usernames guaranteed?",
        answer:
          "No. Availability changes continuously and is not checked by this tool. Verify every domain, username, and channel name yourself before launch.",
      },
    ],
    relatedSlugs: [
      "instagram-name-generator",
      "tiktok-username-generator",
      "youtube-channel-name-generator",
    ],
  },
  {
    slug: "social-media-hook-generator",
    name: "Free Social Media Hook Generator",
    shortName: "Hook generator",
    description:
      "Generate direct opening lines for educational, opinion, story, and launch posts without empty hype.",
    category: "Write",
    kind: "hooks",
    seoTitle: "Free Social Media Hook Generator | bento.surf",
    seoDescription:
      "Generate social media hooks for Instagram, LinkedIn, X, Threads, Facebook, and TikTok. Get practical opening lines without sign-up.",
    fields: [
      {
        key: "topic",
        label: "What is the post about?",
        placeholder: "Building a consistent content system",
        multiline: true,
      },
      { key: "audience", label: "Who is it for?", placeholder: "Busy solo creators" },
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
    howItWorks: [
      "Describe the post topic",
      "Add the reader you want to reach",
      "Choose a hook that earns the next line",
    ],
    tips: [
      "Make the opening specific enough to create curiosity.",
      "Do not promise a result the post cannot deliver.",
      "Match the hook to the first line of the actual content.",
    ],
    faqs: [
      {
        question: "What is a social media hook?",
        answer:
          "It is the opening line or idea that gives someone a reason to stop and continue reading or watching.",
      },
      {
        question: "Will the hooks work on every platform?",
        answer:
          "The structures are broadly useful, but you should adjust length and tone to the platform and your audience.",
      },
    ],
    relatedSlugs: [
      "social-media-caption-generator",
      "blog-to-social-post-converter",
      "social-media-character-counter",
    ],
  },
  {
    slug: "hashtag-generator",
    name: "Free Social Media Hashtag Generator",
    shortName: "Hashtag generator",
    description:
      "Turn a topic and a few keywords into a tidy, relevant hashtag set for your next post.",
    category: "Write",
    kind: "hashtags",
    seoTitle: "Free Social Media Hashtag Generator | bento.surf",
    seoDescription:
      "Create relevant topic-based hashtags for Instagram, LinkedIn, TikTok, X, Threads, and Facebook. Free and no sign-up required.",
    fields: [
      { key: "topic", label: "Main topic", placeholder: "Creator marketing" },
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
    howItWorks: ["Enter one focused topic", "Add related words", "Copy a clean hashtag set"],
    tips: [
      "Mix broad category tags with specific topic tags.",
      "Remove any tag that does not describe the actual post.",
      "These are topic ideas, not claims about live trend volume.",
    ],
    faqs: [
      {
        question: "Are these trending hashtags?",
        answer:
          "No. The tool creates relevant topic-based hashtags from your words; it does not claim to measure live trend or search volume.",
      },
      {
        question: "How many hashtags should I use?",
        answer:
          "There is no universal number. Use only the tags that accurately describe the post and follow the current guidance of the network you publish to.",
      },
    ],
    relatedSlugs: [
      "social-media-caption-generator",
      "instagram-bio-generator",
      "social-media-character-counter",
    ],
  },
  {
    slug: "social-media-caption-generator",
    name: "Free Social Media Caption Generator",
    shortName: "Caption generator",
    description:
      "Build a useful caption from one topic, one takeaway, and one action you want the reader to take.",
    category: "Write",
    kind: "caption",
    seoTitle: "Free Social Media Caption Generator | bento.surf",
    seoDescription:
      "Generate structured social media caption drafts for Instagram, LinkedIn, Facebook, X, Threads, and TikTok without signing up.",
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
      { key: "cta", label: "Call to action", placeholder: "Save this for your next planning day" },
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
    howItWorks: ["Add the topic and takeaway", "Choose a platform", "Edit and copy the draft"],
    tips: [
      "Keep one message per caption.",
      "Replace generic claims with a real example.",
      "Use a call to action that fits what the reader just learned.",
    ],
    faqs: [
      {
        question: "Can I publish the caption directly?",
        answer:
          "Treat it as a structured first draft. Add your own example, voice, and facts before publishing.",
      },
      {
        question: "Which platforms does it support?",
        answer:
          "You can shape drafts for Instagram, LinkedIn, X, Facebook, Threads, TikTok, and YouTube.",
      },
    ],
    relatedSlugs: [
      "facebook-caption-generator",
      "linkedin-caption-generator",
      "threads-caption-generator",
    ],
  },
  {
    slug: "blog-to-social-post-converter",
    name: "Blog to Social Post Converter",
    shortName: "Blog to social converter",
    description:
      "Pull a clear social draft from a longer article, newsletter, transcript, or set of notes.",
    category: "Write",
    kind: "repurpose",
    seoTitle: "Free Blog to Social Media Post Converter | bento.surf",
    seoDescription:
      "Turn a blog post, newsletter, transcript, or article into a concise social media draft for LinkedIn, Instagram, X, Threads, or Facebook.",
    fields: [
      {
        key: "source",
        label: "Paste your source text",
        placeholder: "Paste an article, newsletter, transcript, or notes…",
        multiline: true,
      },
      {
        key: "tone",
        label: "Tone",
        placeholder: "Conversational",
        options: ["Conversational", "Educational", "Opinionated", "Story-led", "Minimal"],
      },
    ],
    howItWorks: [
      "Paste the source text",
      "Choose a destination network",
      "Edit the condensed draft",
    ],
    tips: [
      "Choose one lesson instead of summarizing everything.",
      "Add an example only you can provide.",
      "Link to the full article when the social post creates genuine interest.",
    ],
    faqs: [
      {
        question: "Does the converter send my article anywhere?",
        answer:
          "It sends the source text you enter to Bento's server-side AI provider to create the draft. Bento does not include it in product analytics.",
      },
      {
        question: "Will it replace editing?",
        answer:
          "No. It creates a concise starting point. Review the meaning, add your voice, and verify every claim before publishing.",
      },
    ],
    relatedSlugs: [
      "social-media-hook-generator",
      "social-media-caption-generator",
      "social-post-formatter",
    ],
  },
  {
    slug: "youtube-title-generator",
    name: "Free YouTube Title Generator",
    shortName: "YouTube titles",
    description:
      "Generate specific YouTube title ideas that make the subject and viewer payoff clear without fake urgency.",
    category: "Write",
    kind: "title",
    fixedPlatform: "YouTube",
    seoTitle: "Free AI YouTube Title Generator | bento.surf",
    seoDescription:
      "Generate clear YouTube video title ideas from your topic, audience, and payoff. Get editable options under the title limit for free.",
    fields: [
      { key: "topic", label: "Video topic", placeholder: "How I plan a month of content" },
      { key: "audience", label: "Who is it for?", placeholder: "Solo creators" },
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
    howItWorks: ["Describe the video", "Add its viewer payoff", "Choose and refine a title"],
    tips: [
      "Make the subject legible without relying on the thumbnail.",
      "Put the differentiating detail before generic category words.",
      "Avoid a promise the video does not fully deliver.",
    ],
    faqs: [
      {
        question: "How long should a YouTube title be?",
        answer:
          "YouTube allows up to 100 characters, but the most important words should appear early because surfaces can truncate the rest.",
      },
      {
        question: "Does this predict click-through rate?",
        answer:
          "No. It creates clear title options from your inputs. Performance depends on the topic, thumbnail, audience, distribution, and whether the video delivers the promise.",
      },
    ],
    relatedSlugs: [
      "youtube-description-generator",
      "youtube-tags-generator",
      "youtube-caption-generator",
    ],
  },
  {
    slug: "youtube-description-generator",
    name: "Free YouTube Description Generator",
    shortName: "YouTube descriptions",
    description:
      "Turn a video summary into a structured YouTube description with useful context, key points, and a clean next action.",
    category: "Write",
    kind: "description",
    fixedPlatform: "YouTube",
    seoTitle: "Free AI YouTube Description Generator | bento.surf",
    seoDescription:
      "Generate an editable YouTube video description with a summary, key points, keywords, and call to action. Free and no sign-up.",
    fields: [
      {
        key: "summary",
        label: "What happens in the video?",
        placeholder: "Describe the actual video, its examples, and its conclusion…",
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
      { key: "cta", label: "Next action", placeholder: "Try the free planning template" },
      {
        key: "length",
        label: "Description length",
        placeholder: "Medium",
        options: ["Short", "Medium", "Detailed"],
      },
    ],
    howItWorks: [
      "Summarize the real video",
      "Add keywords and next step",
      "Edit and copy the description",
    ],
    tips: [
      "Use the first lines for a human-readable summary before links and boilerplate.",
      "Add timestamps only after you have verified their exact positions.",
      "Do not repeat a keyword unnaturally for search engines.",
    ],
    faqs: [
      {
        question: "Will it create timestamps automatically?",
        answer:
          "No. Without the actual timed transcript it cannot know accurate chapter positions. Add verified timestamps after generation.",
      },
      {
        question: "Does a generated description guarantee YouTube rankings?",
        answer:
          "No. The tool helps make the video understandable to viewers and systems, but relevance, satisfaction, originality, and watch behavior matter too.",
      },
    ],
    relatedSlugs: [
      "youtube-title-generator",
      "youtube-tags-generator",
      "blog-to-social-post-converter",
    ],
  },
  {
    slug: "youtube-tags-generator",
    name: "Free YouTube Tags Generator",
    shortName: "YouTube tags",
    description:
      "Create a focused YouTube tag set from the video's real topic, vocabulary, and audience without fake volume claims.",
    category: "Write",
    kind: "tags",
    fixedPlatform: "YouTube",
    seoTitle: "Free AI YouTube Tags Generator | bento.surf",
    seoDescription:
      "Generate relevant YouTube video tags from a topic and keywords. Copy a clean comma-separated set for free with no sign-up.",
    fields: [
      { key: "topic", label: "Video topic", placeholder: "Building a creator content system" },
      {
        key: "keywords",
        label: "Related phrases",
        placeholder: "content planning, social scheduling",
      },
      { key: "audience", label: "Target viewer", placeholder: "Independent creators" },
      {
        key: "count",
        label: "Number of tags",
        placeholder: "15",
        options: ["10", "15", "20", "25"],
      },
    ],
    howItWorks: ["Enter the real topic", "Add related phrases", "Copy the tag set"],
    tips: [
      "Use tags that describe the actual video, including useful spelling variations.",
      "Do not add unrelated high-volume topics.",
      "Treat tags as supporting metadata, not a substitute for a clear title and video.",
    ],
    faqs: [
      {
        question: "Are these live trending YouTube tags?",
        answer:
          "No. The model creates semantically relevant tags from your inputs and does not claim live search volume or trend data.",
      },
      {
        question: "What format does the tool return?",
        answer:
          "It returns one comma-separated line of plain tags so you can review and paste the relevant ones into YouTube Studio.",
      },
    ],
    relatedSlugs: ["youtube-title-generator", "youtube-description-generator", "hashtag-generator"],
  },
  {
    slug: "twitter-thread-generator",
    name: "Free X (Twitter) Thread Generator",
    shortName: "X thread generator",
    description:
      "Break a substantial idea into a coherent X thread where every post advances the argument and fits the standard limit.",
    category: "Write",
    kind: "thread",
    fixedPlatform: "X",
    seoTitle: "Free AI Twitter Thread Generator for X | bento.surf",
    seoDescription:
      "Turn notes or an idea into an editable X (Twitter) thread with posts under 280 characters. Free and no sign-up required.",
    fields: [
      {
        key: "source",
        label: "Idea, notes, or source",
        placeholder: "Paste the argument, lesson, or notes the thread must preserve…",
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
    howItWorks: [
      "Paste the complete idea",
      "Choose tone and thread length",
      "Edit each post before publishing",
    ],
    tips: [
      "Make the first post useful even when it appears without the rest of the thread.",
      "Give each post one job instead of splitting sentences at arbitrary character counts.",
      "Verify every claim and remove any repeated conclusion.",
    ],
    faqs: [
      {
        question: "Does every generated post fit 280 characters?",
        answer:
          "Yes. The server validates each returned thread post against the standard 280-character limit.",
      },
      {
        question: "Can I generate a thread from a blog or transcript?",
        answer:
          "Yes. Paste the relevant source, but keep it focused enough that the selected number of posts can preserve the important reasoning.",
      },
    ],
    relatedSlugs: [
      "twitter-caption-generator",
      "blog-to-social-post-converter",
      "social-media-hook-generator",
    ],
  },
  {
    slug: "transcript-to-social-post",
    name: "Free Transcript to Social Post Converter",
    shortName: "Transcript to social post",
    description:
      "Turn a podcast, interview, webinar, or voice-note transcript into three platform-ready posts that preserve the source.",
    category: "Write",
    kind: "repurpose",
    seoTitle: "Free AI Transcript to Social Post Converter | bento.surf",
    seoDescription:
      "Turn a podcast, webinar, interview, or video transcript into editable social posts for Instagram, LinkedIn, X, Facebook, Threads, TikTok, YouTube, or Reddit.",
    fields: [
      {
        key: "source",
        label: "Transcript",
        placeholder: "Paste the transcript you own or have permission to repurpose…",
        multiline: true,
      },
      { key: "audience", label: "Who is it for?", placeholder: "Independent creators" },
      { key: "goal", label: "What should the post do?", placeholder: "Teach one useful lesson" },
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
    howItWorks: ["Paste the transcript", "Choose a network and goal", "Edit one of three posts"],
    tips: [
      "Remove private or irrelevant sections before pasting the transcript.",
      "Keep names, numbers, quotations, and technical terms exactly as the source supports them.",
      "Choose one post angle at a time instead of trying to summarize the entire conversation.",
    ],
    faqs: [
      {
        question: "Will the tool add facts that were not in my transcript?",
        answer:
          "It is instructed to preserve the supplied source and not invent quotations, events, examples, or results. Review every post against the transcript before publishing.",
      },
      {
        question: "Can I create the transcript with Bento first?",
        answer:
          "Yes. Use Bento's audio-to-transcript tool for a supported audio file, review the transcript, then paste the relevant section here.",
      },
    ],
    relatedSlugs: ["audio-to-transcript", "transcript-to-x-thread", "social-post-rewriter"],
  },
  {
    slug: "transcript-to-x-thread",
    name: "Free Transcript to X (Twitter) Thread Converter",
    shortName: "Transcript to X thread",
    description:
      "Turn a substantial transcript into a coherent X thread where every post preserves the source and fits 280 characters.",
    category: "Write",
    kind: "thread",
    fixedPlatform: "X",
    seoTitle: "Free Transcript to X Thread Converter | bento.surf",
    seoDescription:
      "Convert a podcast, interview, webinar, or video transcript into an editable X (Twitter) thread with every post under 280 characters.",
    fields: [
      {
        key: "source",
        label: "Transcript",
        placeholder: "Paste the transcript or the section the thread must preserve…",
        multiline: true,
      },
      { key: "audience", label: "Who is it for?", placeholder: "Creators building an audience" },
      { key: "goal", label: "Thread goal", placeholder: "Explain the five-part framework" },
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
    howItWorks: ["Paste the transcript", "Choose five, seven, or ten posts", "Edit the thread"],
    tips: [
      "Use a focused transcript section with one clear argument or story.",
      "Make the opening post valuable even when someone sees it outside the thread.",
      "Verify quotations and remove repeated conclusions before publishing.",
    ],
    faqs: [
      {
        question: "Does every thread post fit X's standard limit?",
        answer:
          "Yes. The server rejects generated items over 280 Unicode characters and requires exactly the number of posts you selected.",
      },
      {
        question: "Does this simply split the transcript into chunks?",
        answer:
          "No. AI reorganizes the source into complete, ordered posts. Use the deterministic thread splitter instead when you only want to divide finished copy.",
      },
    ],
    relatedSlugs: ["audio-to-transcript", "transcript-to-social-post", "twitter-thread-splitter"],
  },
  {
    slug: "carousel-outline-generator",
    name: "Free Social Media Carousel Outline Generator",
    shortName: "Carousel outline",
    description:
      "Plan an ordered five, seven, or ten-slide social carousel with concise copy and a simple visual direction for every slide.",
    category: "Write",
    kind: "repurpose",
    seoTitle: "Free AI Social Media Carousel Outline Generator | bento.surf",
    seoDescription:
      "Generate a slide-by-slide Instagram, LinkedIn, or social carousel outline with on-slide copy, visual direction, and a clear ending.",
    fields: [
      {
        key: "topic",
        label: "Topic or source notes",
        placeholder: "Explain the lesson, argument, or process the carousel should teach…",
        multiline: true,
      },
      { key: "audience", label: "Who is it for?", placeholder: "First-time course creators" },
      { key: "takeaway", label: "Main takeaway", placeholder: "Start with the learner outcome" },
      { key: "cta", label: "Final action", placeholder: "Save this outline for later" },
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
    howItWorks: ["Add the lesson or notes", "Choose a platform and slide count", "Edit each slide"],
    tips: [
      "Give each slide one job and one readable idea.",
      "Make slide one promise a specific, honest payoff rather than vague curiosity.",
      "Use the visual directions as layout guidance; this tool does not generate images.",
    ],
    faqs: [
      {
        question: "Does the tool generate carousel images?",
        answer:
          "No. It generates an editable outline with on-slide copy and simple visual direction so you can design the slides in your preferred editor.",
      },
      {
        question: "How many slides can I plan?",
        answer:
          "Choose five, seven, or ten. The server requires exactly that number of slide outputs and limits each slide to 500 Unicode characters.",
      },
    ],
    relatedSlugs: [
      "social-media-hook-generator",
      "social-image-resizer",
      "social-media-caption-generator",
    ],
  },
  {
    slug: "content-idea-generator",
    name: "Free Social Media Content Idea Generator",
    shortName: "Content ideas",
    description:
      "Generate specific content premises for your niche, audience, goal, and chosen social network without fake trend claims.",
    category: "Write",
    kind: "hooks",
    seoTitle: "Free AI Social Media Content Idea Generator | bento.surf",
    seoDescription:
      "Generate original social media content ideas for your niche, audience, goals, and content pillars. Choose a platform and get usable premises free.",
    fields: [
      { key: "niche", label: "Your niche", placeholder: "Creator business education" },
      { key: "audience", label: "Who is it for?", placeholder: "Creators with a small audience" },
      { key: "goal", label: "Content goal", placeholder: "Build trust before a product launch" },
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
    howItWorks: [
      "Describe your niche and audience",
      "Choose a network and goal",
      "Pick an idea to develop",
    ],
    tips: [
      "Use narrow content pillars so the ideas are meaningfully different.",
      "Add a real example or experience before turning an idea into a post.",
      "Choose ideas your audience can act on, not topics that are merely broad or popular.",
    ],
    faqs: [
      {
        question: "Are these ideas based on live trends?",
        answer:
          "No. The model creates relevant ideas from the details you provide and does not claim access to current search volume or platform trends.",
      },
      {
        question: "What does each result include?",
        answer:
          "Each result contains a specific premise, a suitable content format, and the useful takeaway for your audience rather than only a generic topic label.",
      },
    ],
    relatedSlugs: [
      "social-media-hook-generator",
      "carousel-outline-generator",
      "reddit-caption-generator",
    ],
  },
  {
    slug: "call-to-action-generator",
    name: "Free Social Media Call to Action Generator",
    shortName: "Call to action generator",
    description:
      "Generate clear, low-hype calls to action around one offer, one audience, and one honest next step.",
    category: "Write",
    kind: "hooks",
    seoTitle: "Free AI Social Media Call to Action Generator | bento.surf",
    seoDescription:
      "Generate clear calls to action for social posts, creator offers, lead magnets, bookings, and products without fake urgency or guaranteed outcomes.",
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
      { key: "action", label: "Action to take", placeholder: "Download the worksheet" },
      { key: "destination", label: "Where will they go?", placeholder: "The link in my bio" },
      {
        key: "tone",
        label: "Tone",
        placeholder: "Direct",
        options: ["Direct", "Warm", "Conversational", "Confident", "Minimal"],
      },
    ],
    howItWorks: ["Describe the offer", "Choose a network and tone", "Pick one clear next step"],
    tips: [
      "Ask for one action instead of stacking comments, shares, follows, and clicks.",
      "Name what happens after the click when the destination is not obvious.",
      "Use urgency only when a real deadline or limit exists.",
    ],
    faqs: [
      {
        question: "How many calls to action does it create?",
        answer:
          "It returns exactly eight editable options, each capped at 220 Unicode characters and adapted to the selected social network.",
      },
      {
        question: "Will it create scarcity or guarantees?",
        answer:
          "It is instructed not to invent scarcity, deadlines, guaranteed outcomes, or other claims you did not provide.",
      },
    ],
    relatedSlugs: [
      "social-media-caption-generator",
      "social-media-hook-generator",
      "utm-link-builder",
    ],
  },
  {
    slug: "short-form-video-script-generator",
    name: "Free Short-Form Video Script Generator",
    shortName: "Short-form video script",
    description:
      "Create a practical short-form video script with a hook, scenes, spoken lines, on-screen text, and one next action.",
    category: "Write",
    kind: "repurpose",
    seoTitle: "Free AI Short-Form Video Script Generator | bento.surf",
    seoDescription:
      "Generate editable TikTok, Instagram Reel, YouTube Short, LinkedIn, or social video scripts with scenes, spoken lines, on-screen text, and a CTA.",
    fields: [
      {
        key: "topic",
        label: "Topic or source notes",
        placeholder: "Describe the idea, real example, and points the video must cover…",
        multiline: true,
      },
      {
        key: "audience",
        label: "Who is it for?",
        placeholder: "Creators launching a digital product",
      },
      { key: "goal", label: "Video goal", placeholder: "Teach a three-step pricing check" },
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
      { key: "cta", label: "Final action", placeholder: "Save this before pricing your offer" },
    ],
    howItWorks: [
      "Add the real topic and examples",
      "Choose format and duration",
      "Edit the complete script",
    ],
    tips: [
      "Read the spoken lines aloud and trim anything that does not fit the chosen duration.",
      "Use shots and demonstrations you can actually produce.",
      "Keep on-screen text shorter than the spoken explanation.",
    ],
    faqs: [
      {
        question: "Does this generate a video?",
        answer:
          "No. It generates an editable text script and scene plan. You record and edit the video using your own footage and tools.",
      },
      {
        question: "Is the spoken script guaranteed to fit the selected duration?",
        answer:
          "The prompt asks for realistic pacing, but speaking speed varies. Read it aloud, time it, and shorten the final draft when necessary.",
      },
    ],
    relatedSlugs: [
      "social-media-hook-generator",
      "content-idea-generator",
      "social-media-caption-generator",
    ],
  },
  {
    slug: "social-post-rewriter",
    name: "Free AI Social Media Post Rewriter",
    shortName: "Social post rewriter",
    description:
      "Rewrite an existing social post for a clearer goal, audience, tone, and platform without changing its underlying facts.",
    category: "Write",
    kind: "repurpose",
    seoTitle: "Free AI Social Media Post Rewriter | bento.surf",
    seoDescription:
      "Rewrite a social media post for Instagram, LinkedIn, X, Facebook, Threads, TikTok, YouTube, or Reddit while preserving its facts and links.",
    fields: [
      {
        key: "source",
        label: "Original post",
        placeholder: "Paste the post you want to improve…",
        multiline: true,
      },
      { key: "audience", label: "Who is it for?", placeholder: "Independent creators" },
      { key: "goal", label: "Rewrite goal", placeholder: "Make the lesson easier to understand" },
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
    howItWorks: [
      "Paste the original post",
      "Choose the platform and goal",
      "Edit one of three rewrites",
    ],
    tips: [
      "List any names, numbers, links, and wording that must remain exact.",
      "Compare every rewrite with the original before publishing.",
      "Choose the clearest version, not automatically the longest or most dramatic one.",
    ],
    faqs: [
      {
        question: "Will the rewriter change facts or links?",
        answer:
          "It is instructed to preserve every supplied fact, name, number, link, and explicit constraint. You should still verify the final draft against the source.",
      },
      {
        question: "How is this different from the post formatter?",
        answer:
          "The formatter only cleans spacing in your browser. This tool sends the post to server-side AI and returns three rewritten versions with different phrasing and structure.",
      },
    ],
    relatedSlugs: [
      "social-post-formatter",
      "call-to-action-generator",
      "social-media-character-counter",
    ],
  },
  {
    slug: "social-bold-italic-text",
    name: "Social Media Bold & Italic Text Generator",
    shortName: "Bold and italic text",
    description:
      "Convert plain letters into copyable Unicode bold or italic text for social posts, bios, and headings.",
    category: "Format",
    kind: "unicode",
    seoTitle: "Bold and Italic Text Generator for Instagram and X | Bento",
    seoDescription:
      "Turn plain text into copy-and-paste bold, italic, and bold italic Unicode letters for Instagram, X, LinkedIn, and Threads posts and bios. Free, no sign-up.",
    howItWorks: ["Type or paste plain text", "Choose a Unicode style", "Copy the converted text"],
    tips: [
      "Use styled text for short emphasis, not entire paragraphs.",
      "Some screen readers pronounce mathematical Unicode characters poorly.",
      "Preview the pasted result on the destination platform before publishing.",
    ],
    faqs: [
      {
        question: "Is this real rich-text bold formatting?",
        answer:
          "No. Social networks usually do not support rich text in captions, so the tool substitutes mathematical Unicode characters that look bold or italic.",
      },
      {
        question: "Will it work on every device?",
        answer:
          "Most modern devices display the characters, but fonts and accessibility behavior vary. Keep a plain-language version and use the styling sparingly.",
      },
    ],
    relatedSlugs: [
      "social-post-formatter",
      "social-media-character-counter",
      "instagram-line-break-generator",
    ],
  },
  {
    slug: "twitter-thread-splitter",
    name: "Free X (Twitter) Thread Splitter",
    shortName: "X thread splitter",
    description:
      "Split finished copy into numbered X posts at word boundaries while keeping every post within 280 characters.",
    category: "Format",
    kind: "thread-splitter",
    fixedPlatform: "X",
    seoTitle: "Free Twitter Thread Splitter for X | bento.surf",
    seoDescription:
      "Split long text into copyable X (Twitter) thread posts under 280 characters. Add numbering automatically in your browser.",
    howItWorks: [
      "Paste the finished thread",
      "Choose automatic numbering",
      "Copy each fitted post",
    ],
    tips: [
      "Edit after splitting so every post advances a complete thought.",
      "Keep the first post understandable outside the thread.",
      "Check links and mentions after copying because they can affect platform counting.",
    ],
    faqs: [
      {
        question: "Does this rewrite my thread?",
        answer:
          "No. It deterministically splits your existing words and optional numbering; it does not send the text to an AI provider.",
      },
      {
        question: "How are very long words handled?",
        answer:
          "A single token longer than the available limit is split by Unicode character so every output still fits.",
      },
    ],
    relatedSlugs: [
      "twitter-thread-generator",
      "twitter-caption-generator",
      "social-media-character-counter",
    ],
  },
  {
    slug: "social-image-resizer",
    name: "Free Social Media Image Resizer",
    shortName: "Social image resizer",
    description:
      "Resize one image for Instagram, Stories, LinkedIn, X, or YouTube with real crop and contain controls.",
    category: "Media",
    kind: "image-resizer",
    seoTitle: "Free Social Media Image Resizer | bento.surf",
    seoDescription:
      "Resize images for Instagram, Stories, Reels, LinkedIn, X, and YouTube. Preserve aspect ratio, choose crop or contain, and download locally.",
    howItWorks: [
      "Choose a JPG, PNG, or WebP",
      "Pick a platform size and fit",
      "Download the resized image",
    ],
    tips: [
      "Use fill and crop when edge-to-edge composition matters.",
      "Use show full image when no part of the source can be removed.",
      "Check text and faces inside each platform's visible safe area.",
    ],
    faqs: [
      {
        question: "Will the tool stretch or squash my image?",
        answer:
          "No. Fill mode center-crops to the target ratio; contain mode preserves the full image and adds a background where needed.",
      },
      {
        question: "Is my image uploaded to Bento?",
        answer: "No. Decoding, resizing, and export happen locally in your browser.",
      },
    ],
    relatedSlugs: ["image-compressor", "image-splitter", "social-media-caption-generator"],
  },
  {
    slug: "image-compressor",
    name: "Free Image Compressor",
    shortName: "Image compressor",
    description:
      "Compress a JPG, PNG, or WebP into a smaller WebP file with a visible quality control and no upload.",
    category: "Media",
    kind: "image-compressor",
    seoTitle: "Free Image Compressor for Creators | bento.surf",
    seoDescription:
      "Compress JPG, PNG, and WebP images locally in your browser. Control export quality and download a smaller WebP without uploading.",
    howItWorks: ["Choose an image", "Set the export quality", "Preview and download WebP"],
    tips: [
      "Start near 75% and inspect faces, gradients, and small text.",
      "Keep an original file before replacing a source asset.",
      "Resize oversized dimensions as well when a platform never displays the full resolution.",
    ],
    faqs: [
      {
        question: "Why does the compressor export WebP?",
        answer:
          "WebP usually provides a useful quality-to-size balance for web and social assets while remaining widely supported.",
      },
      {
        question: "Will every file become smaller?",
        answer:
          "Not always. A tiny or already optimized image may be smaller in its original format, so compare the displayed output size before downloading.",
      },
    ],
    relatedSlugs: ["social-image-resizer", "image-flipper", "background-remover"],
  },
  {
    slug: "background-remover",
    name: "Free AI Background Remover",
    shortName: "Background remover",
    description:
      "Remove the background from a JPG, PNG, or WebP and download a transparent PNG without creating an account.",
    category: "Media",
    kind: "background-remover",
    seoTitle: "Free AI Background Remover for Images | bento.surf",
    seoDescription:
      "Remove an image background automatically and download a transparent PNG. Free for JPG, PNG, and WebP images with no sign-up.",
    howItWorks: ["Choose an image", "Remove the background", "Download the transparent PNG"],
    tips: [
      "Use a clear subject with visible separation from the background.",
      "Check hair, glass, and soft shadows closely before publishing.",
      "Keep the original image in case you need to refine the result elsewhere.",
    ],
    faqs: [
      {
        question: "Does Bento save my image?",
        answer:
          "No. The image is sent to Cloudflare only after you start background removal, and Bento does not save the upload or result.",
      },
      {
        question: "What does the tool download?",
        answer:
          "It downloads a PNG with transparent pixels where the detected background was removed.",
      },
    ],
    relatedSlugs: ["social-image-resizer", "image-compressor", "image-flipper"],
  },
  {
    slug: "image-flipper",
    name: "Free Image Flipper",
    shortName: "Image flipper",
    description:
      "Mirror an image horizontally or vertically at its original dimensions, entirely inside your browser.",
    category: "Media",
    kind: "image-flipper",
    seoTitle: "Free Image Flipper: Horizontal or Vertical | bento.surf",
    seoDescription:
      "Flip a JPG, PNG, or WebP horizontally or vertically and download a full-resolution PNG. Free local browser processing.",
    howItWorks: ["Choose an image", "Pick horizontal or vertical", "Download the flipped PNG"],
    tips: [
      "Horizontal mirroring is useful when a subject needs to face into a layout.",
      "Do not mirror readable text or recognizable logos accidentally.",
      "Review asymmetric faces and products before publishing.",
    ],
    faqs: [
      {
        question: "Does flipping reduce the image dimensions?",
        answer: "No. The output keeps the original pixel dimensions and exports as PNG.",
      },
      {
        question: "Can I undo the flip?",
        answer: "Yes. Process the original again or flip the downloaded result on the same axis.",
      },
    ],
    relatedSlugs: ["social-image-resizer", "image-compressor", "image-splitter"],
  },
  {
    slug: "image-splitter",
    name: "Free Instagram Image Splitter",
    shortName: "Image splitter",
    description:
      "Slice a wide design into two or three full-height tiles for a swipe carousel or connected profile layout.",
    category: "Media",
    kind: "image-splitter",
    fixedPlatform: "Instagram",
    seoTitle: "Free Instagram Carousel Image Splitter | bento.surf",
    seoDescription:
      "Split one image into two or three equal vertical tiles for Instagram carousels and connected layouts. Process and download locally.",
    howItWorks: ["Choose a wide image", "Select two or three tiles", "Download each tile in order"],
    tips: [
      "Design at the combined aspect ratio before splitting for predictable composition.",
      "Keep important text away from tile boundaries.",
      "Upload the numbered pieces in ascending order.",
    ],
    faqs: [
      {
        question: "Does the splitter resize the original first?",
        answer:
          "No. It divides the source pixels into equal vertical tiles and assigns any remainder to the final tile.",
      },
      {
        question: "Can I download all pieces as a ZIP?",
        answer:
          "The first release provides direct download buttons for each tile, avoiding an extra ZIP dependency and keeping processing local.",
      },
    ],
    relatedSlugs: ["social-image-resizer", "image-compressor", "instagram-caption-generator"],
  },
  {
    slug: "social-media-downloader",
    name: "Free All-in-One Social Media Downloader",
    shortName: "All-in-one downloader",
    description:
      "Download available videos, GIFs, photos, carousels, and PDFs from public YouTube, Instagram, TikTok, X, Pinterest, and LinkedIn posts.",
    category: "Media",
    kind: "media-downloader",
    seoTitle: "Free All-in-One Social Media Downloader | bento.surf",
    seoDescription:
      "Download available videos, photos, GIFs, carousels, and PDFs from public YouTube, Instagram, TikTok, X, Pinterest, and LinkedIn links.",
    howItWorks: [
      "Paste one supported public post link",
      "Let Bento detect the platform and media",
      "Download each available file",
    ],
    tips: [
      "Use the direct post, video, Reel, Short, or status URL instead of a profile page.",
      "Choose Best available unless you need a smaller video file for a specific device.",
      "If a secure link expires, Bento refreshes it automatically when you select Download.",
    ],
    faqs: [
      {
        question: "Which social media links does the all-in-one downloader support?",
        answer:
          "Use public YouTube videos and Shorts, Instagram posts and Reels, TikTok videos and photo posts, X status links, Pinterest pins, and LinkedIn posts.",
      },
      {
        question: "Can it download photos and carousel posts as well as videos?",
        answer:
          "Yes. Available photos, videos, and GIFs appear in post order. LinkedIn document posts can include a PDF and page images. When a document has more than 19 pages, Bento returns the full PDF.",
      },
      {
        question: "Can Bento access private or login-only posts?",
        answer:
          "No. Bento does not sign in to social networks or bypass private, removed, age-restricted, region-restricted, or otherwise unavailable media.",
      },
    ],
    relatedSlugs: [
      "youtube-video-downloader",
      "instagram-carousel-downloader",
      "twitter-image-downloader",
    ],
  },
  {
    slug: "youtube-video-downloader",
    name: "Free YouTube Video Downloader",
    shortName: "YouTube downloader",
    description:
      "Paste a public YouTube video or Shorts link and download the video files Bento can securely retrieve for that source.",
    category: "Media",
    kind: "video-downloader",
    fixedPlatform: "YouTube",
    seoTitle: "Free YouTube Video & Shorts Downloader | bento.surf",
    seoDescription:
      "Download an available public YouTube video or Short through a secure temporary link. Choose a preferred quality, no sign-up required.",
    howItWorks: [
      "Paste one public YouTube link",
      "Choose a preferred quality",
      "Download an available file",
    ],
    tips: [
      "Paste a single video or Shorts URL rather than a channel or playlist.",
      "Choose Best available unless you need a smaller file for a specific device.",
      "If a secure link expires, Bento refreshes it automatically when you select Download.",
    ],
    faqs: [
      {
        question: "Does the downloader work with YouTube Shorts?",
        answer:
          "Yes. Paste the public Shorts URL just as you would a regular video URL. Private, members-only, removed, or access-restricted videos cannot be retrieved.",
      },
      {
        question: "Can I always download a YouTube video in 1080p or 4K?",
        answer:
          "No. Bento requests your preferred quality, but the files returned depend on the source and provider. The result only shows files that are actually available.",
      },
      {
        question: "Where is the downloaded video saved?",
        answer:
          "Your browser normally saves it to the device Downloads folder. Bento does not add the file to your Bento account or permanent storage.",
      },
    ],
    relatedSlugs: [
      "social-media-downloader",
      "youtube-thumbnail-downloader",
      "youtube-to-transcript",
    ],
  },
  {
    slug: "instagram-video-downloader",
    name: "Free Instagram Video Downloader",
    shortName: "Instagram downloader",
    description:
      "Download available video from a public Instagram Reel or video post using a secure temporary link.",
    category: "Media",
    kind: "video-downloader",
    fixedPlatform: "Instagram",
    seoTitle: "Instagram Video Downloader: Save Reels and Videos | Bento",
    seoDescription:
      "Paste a public Instagram Reel or video post link and download the available video through a secure temporary link. Works with carousels. Free, no sign-up.",
    howItWorks: [
      "Paste a public Instagram link",
      "Let Bento find the video",
      "Download an available file",
    ],
    tips: [
      "Use the direct Reel or post URL rather than a profile link.",
      "Only public media that opens without signing in can be processed.",
      "If a secure link expires, Bento refreshes it automatically when you select Download.",
    ],
    faqs: [
      {
        question: "Which Instagram links work?",
        answer:
          "Bento supports public Reels and public video posts that the provider can access. Private profiles, expired Stories, profile pages, and login-only media are not supported.",
      },
      {
        question: "What happens with a carousel containing more than one video?",
        answer:
          "Every video file returned by the provider appears as a separate download option. Bento does not invent missing carousel items or photo downloads.",
      },
      {
        question: "Does Bento remove Instagram watermarks?",
        answer:
          "Bento delivers the file returned for the public source. It does not promise watermark removal or modify the media after retrieval.",
      },
    ],
    relatedSlugs: [
      "social-media-downloader",
      "instagram-photo-downloader",
      "instagram-carousel-downloader",
    ],
  },
  {
    slug: "tiktok-video-downloader",
    name: "Free TikTok Video Downloader",
    shortName: "TikTok downloader",
    description:
      "Paste a public TikTok video link and download the video file Bento can securely retrieve for that post.",
    category: "Media",
    kind: "video-downloader",
    fixedPlatform: "TikTok",
    seoTitle: "Free TikTok Video Downloader Online | bento.surf",
    seoDescription:
      "Download an available public TikTok video through a secure temporary link. Supports standard and shared TikTok video URLs without sign-up.",
    howItWorks: [
      "Paste a public TikTok video link",
      "Choose a preferred quality",
      "Download the available video",
    ],
    tips: [
      "Both standard TikTok video links and supported short share links can be submitted.",
      "Photo-mode posts and slideshows may not contain a downloadable video file.",
      "If a secure link expires, Bento refreshes it automatically when you select Download.",
    ],
    faqs: [
      {
        question: "Can I paste a short TikTok share link?",
        answer:
          "Yes, when the short URL resolves to a public TikTok video. Restricted, removed, or region-blocked links can still fail when the provider cannot access them.",
      },
      {
        question: "Will the downloaded TikTok be watermark-free?",
        answer:
          "Only when the provider returns a file without a watermark. Bento does not label or promise a watermark-free result unless that is the actual returned file.",
      },
      {
        question: "Can Bento download private or friends-only TikTok videos?",
        answer:
          "No. Bento does not sign in to TikTok or bypass access controls. The video must be publicly available to the processing provider.",
      },
    ],
    relatedSlugs: ["social-media-downloader", "tiktok-photo-downloader", "tiktok-cover-downloader"],
  },
  {
    slug: "twitter-video-downloader",
    name: "Free X (Twitter) Video Downloader",
    shortName: "X video downloader",
    description:
      "Paste a public X or Twitter post link and download its available native video or animated GIF file.",
    category: "Media",
    kind: "video-downloader",
    fixedPlatform: "X",
    seoTitle: "Free X (Twitter) Video & GIF Downloader | bento.surf",
    seoDescription:
      "Download available video or animated GIF media from a public X or Twitter post through a secure temporary link. No sign-up required.",
    howItWorks: [
      "Paste a public X post link",
      "Let Bento find native media",
      "Download the available file",
    ],
    tips: [
      "Use a direct x.com or twitter.com status URL rather than a profile or search page.",
      "Embedded links from another platform should be opened in that platform's downloader.",
      "If a secure link expires, Bento refreshes it automatically when you select Download.",
    ],
    faqs: [
      {
        question: "Do both x.com and twitter.com links work?",
        answer:
          "Yes. Paste a public status URL from either domain. Protected-account posts and removed or access-restricted posts cannot be retrieved.",
      },
      {
        question: "Can Bento download animated GIFs from X?",
        answer:
          "Yes when X exposes the animation as a native video file. The result identifies it as an animated GIF video and downloads the returned file directly.",
      },
      {
        question: "What if the post embeds a YouTube or other external video?",
        answer:
          "This tool handles native X media only. Open the linked platform and use its matching downloader for externally hosted video.",
      },
    ],
    relatedSlugs: [
      "social-media-downloader",
      "twitter-image-downloader",
      "twitter-caption-generator",
    ],
  },
  {
    slug: "instagram-photo-downloader",
    name: "Free Instagram Photo Downloader",
    shortName: "Instagram photos",
    description:
      "Paste a public Instagram photo-post link and download every available image without stretching or recompressing it.",
    category: "Media",
    kind: "media-downloader",
    fixedPlatform: "Instagram",
    seoTitle: "Instagram Photo Downloader: Save Original Images | Bento",
    seoDescription:
      "Download every photo from a public Instagram post, including multi-image posts, as separate files in source order and without resizing. Free, no sign-up.",
    howItWorks: [
      "Paste a public Instagram post link",
      "Let Bento find the source photos",
      "Preview and download each image",
    ],
    tips: [
      "Use the direct /p/ post URL instead of a profile, feed, Story, or Explore link.",
      "For a post mixing photos and videos, use the Instagram carousel downloader instead.",
      "If a secure link expires, Bento refreshes it automatically when you select Download.",
    ],
    faqs: [
      {
        question: "Can I download every photo from a multi-image Instagram post?",
        answer:
          "Yes. Every photo returned for the public post appears as a separate preview and download, in source order, up to the protected 20-item request limit.",
      },
      {
        question: "Does Bento reduce the photo quality?",
        answer:
          "No. Bento returns the available source image file without resizing, stretching, adding a watermark, or creating an artificial higher-resolution version.",
      },
      {
        question: "Can it download photos from a private Instagram account?",
        answer:
          "No. Bento does not sign in to Instagram or bypass private, login-only, removed, or otherwise restricted posts.",
      },
    ],
    relatedSlugs: [
      "instagram-carousel-downloader",
      "instagram-reel-cover-downloader",
      "social-media-downloader",
    ],
  },
  {
    slug: "instagram-carousel-downloader",
    name: "Free Instagram Carousel Downloader",
    shortName: "Instagram carousels",
    description:
      "Download the available photos, videos, and mixed slides from one public Instagram carousel in source order.",
    category: "Media",
    kind: "media-downloader",
    fixedPlatform: "Instagram",
    seoTitle: "Free Instagram Carousel Downloader | bento.surf",
    seoDescription:
      "Download available photos and videos from a public Instagram carousel as separate ordered files. Free and no sign-up required.",
    howItWorks: [
      "Paste the public carousel post link",
      "Let Bento collect its available slides",
      "Download the ordered files you need",
    ],
    tips: [
      "Use the direct /p/ URL for the carousel rather than copying a profile or feed URL.",
      "Keep the numbered filenames if you want to preserve the original slide order.",
      "If a secure link expires, Bento refreshes it automatically when you select Download.",
    ],
    faqs: [
      {
        question: "Does the carousel downloader include both photos and videos?",
        answer:
          "Yes. A mixed public carousel can return image, video, and animated media files. Bento labels each available file and keeps the provider's source order.",
      },
      {
        question: "How many Instagram carousel items can Bento return?",
        answer:
          "Bento can return up to 20 available items from one post, matching Instagram's current carousel size while keeping the request and temporary downloads protected.",
      },
      {
        question: "Can it download private, archived, or deleted carousels?",
        answer:
          "No. The post must be public and available to the media provider. Bento does not sign in or bypass account and content restrictions.",
      },
    ],
    relatedSlugs: [
      "instagram-photo-downloader",
      "instagram-video-downloader",
      "social-media-downloader",
    ],
  },
  {
    slug: "tiktok-photo-downloader",
    name: "Free TikTok Photo & Slideshow Downloader",
    shortName: "TikTok photos",
    description:
      "Paste a public TikTok photo-post or slideshow link and download every image Bento can securely retrieve.",
    category: "Media",
    kind: "media-downloader",
    fixedPlatform: "TikTok",
    seoTitle: "TikTok Photo Downloader: Save Slideshow Images Free | Bento",
    seoDescription:
      "Download every image from a public TikTok photo post or slideshow as separate files, in original quality and order. Free, secure, and no sign-up needed.",
    howItWorks: [
      "Paste a public TikTok photo-post link",
      "Let Bento find the slideshow images",
      "Preview and download each photo",
    ],
    tips: [
      "Use a direct TikTok photo URL or a supported short share link.",
      "Keep the ordered filenames if the slideshow sequence matters.",
      "Use the TikTok video downloader when the post contains a normal video instead.",
    ],
    faqs: [
      {
        question: "Which TikTok photo links work?",
        answer:
          "Public TikTok photo and slideshow posts work when the source makes their images available. Standard and supported short share links are accepted; removed or restricted posts can still fail.",
      },
      {
        question: "Does this tool turn a slideshow into a video?",
        answer:
          "No. It returns the available source images as separate files so you can keep their original quality and order. It does not render a new video or add audio.",
      },
      {
        question: "Can Bento download friends-only or private TikTok photos?",
        answer:
          "No. Bento does not sign in to TikTok or bypass friends-only, private, removed, age, or region restrictions.",
      },
    ],
    relatedSlugs: ["tiktok-video-downloader", "tiktok-cover-downloader", "social-media-downloader"],
  },
  {
    slug: "twitter-image-downloader",
    name: "Free X (Twitter) Image Downloader",
    shortName: "X images",
    description:
      "Paste a public X or Twitter status link and download its available native image or multi-image post files.",
    category: "Media",
    kind: "media-downloader",
    fixedPlatform: "X",
    seoTitle: "Free X (Twitter) Image Downloader | bento.surf",
    seoDescription:
      "Download available images from a public X or Twitter status, including multi-image posts. Free and no sign-up required.",
    howItWorks: [
      "Paste a public X or Twitter status link",
      "Let Bento find its native images",
      "Preview and download each file",
    ],
    tips: [
      "Use the direct x.com or twitter.com status URL instead of a profile or search page.",
      "For posts containing native video or GIF media, use the X video downloader.",
      "If a secure link expires, Bento refreshes it automatically when you select Download.",
    ],
    faqs: [
      {
        question: "Can it download every image from one X post?",
        answer:
          "Yes. Every native image returned for the public status appears as a separate preview and download. Embedded links to another platform are not treated as native X images.",
      },
      {
        question: "Do both x.com and twitter.com status links work?",
        answer:
          "Yes. Paste a public status URL from either domain. Protected-account, deleted, or access-restricted posts cannot be retrieved.",
      },
      {
        question: "Does Bento crop or recompress downloaded X images?",
        answer:
          "No. Bento returns the available source image file without resizing, cropping, watermarking, or artificially increasing its resolution.",
      },
    ],
    relatedSlugs: [
      "twitter-video-downloader",
      "social-media-downloader",
      "twitter-caption-generator",
    ],
  },
  {
    slug: "youtube-thumbnail-downloader",
    name: "Free YouTube Thumbnail Downloader",
    shortName: "YouTube thumbnail",
    description:
      "Paste a public YouTube video or Shorts link and download its available thumbnail image.",
    category: "Media",
    kind: "cover-downloader",
    fixedPlatform: "YouTube",
    seoTitle: "Free YouTube Thumbnail Downloader | bento.surf",
    seoDescription:
      "Download the available thumbnail from a public YouTube video or Short as an image. Free, secure, and no sign-up required.",
    howItWorks: [
      "Paste one public YouTube link",
      "Let Bento find the thumbnail",
      "Preview and download the image",
    ],
    tips: [
      "Paste a direct video, Shorts, or youtu.be link rather than a channel or playlist.",
      "The source may provide several thumbnail sizes; Bento returns the best available image.",
      "If a secure link expires, Bento refreshes it automatically when you select Download.",
    ],
    faqs: [
      {
        question: "Does this work with YouTube Shorts?",
        answer:
          "Yes. Paste the public Shorts URL and Bento will look for the best thumbnail image the source makes available.",
      },
      {
        question: "Will every thumbnail be full resolution?",
        answer:
          "No. The available dimensions depend on the video and YouTube's source images. Bento returns the highest-quality image it can verify rather than enlarging a smaller file.",
      },
      {
        question: "Can I download a thumbnail from a private video?",
        answer:
          "No. Bento does not sign in to YouTube or bypass private, members-only, removed, age-restricted, or otherwise unavailable videos.",
      },
    ],
    relatedSlugs: ["youtube-video-downloader", "youtube-to-transcript", "youtube-title-generator"],
  },
  {
    slug: "instagram-reel-cover-downloader",
    name: "Free Instagram Reel Cover Downloader",
    shortName: "Instagram Reel cover",
    description:
      "Paste a public Instagram Reel link and download the cover image Bento can securely retrieve.",
    category: "Media",
    kind: "cover-downloader",
    fixedPlatform: "Instagram",
    seoTitle: "Instagram Reel Cover Download: Free, No Login | Bento",
    seoDescription:
      "Need a reel cover download? Paste a public Instagram Reel link, preview the original cover and save it free. No login required.",
    howItWorks: [
      "Paste a public Instagram Reel link",
      "Let Bento find the cover",
      "Preview and download the image",
    ],
    tips: [
      "Use the direct public Reel URL rather than a profile, feed, or Story link.",
      "The downloaded cover is the image the public source exposes; Bento does not recreate it.",
      "If a secure link expires, Bento refreshes it automatically when you select Download.",
    ],
    faqs: [
      {
        question: "Which Instagram links work?",
        answer:
          "This tool supports public Instagram Reel URLs that the media provider can access. Profile pages, private posts, expired Stories, and login-only media are not supported.",
      },
      {
        question: "Does Bento change the Reel cover?",
        answer:
          "No. Bento returns the available source cover without adding text, removing marks, cropping, or artificially increasing its resolution.",
      },
      {
        question: "Can I download a cover from a private account?",
        answer:
          "No. Bento does not sign in to Instagram or bypass private-account and other access controls.",
      },
    ],
    relatedSlugs: ["instagram-video-downloader", "instagram-to-transcript", "social-image-resizer"],
  },
  {
    slug: "tiktok-cover-downloader",
    name: "Free TikTok Cover Downloader",
    shortName: "TikTok cover",
    description:
      "Paste a public TikTok video link and download the available cover image for that post.",
    category: "Media",
    kind: "cover-downloader",
    fixedPlatform: "TikTok",
    seoTitle: "Free TikTok Cover Downloader | bento.surf",
    seoDescription:
      "Download the available cover image from a public TikTok video. Preview and save the image free with no sign-up required.",
    howItWorks: [
      "Paste a public TikTok video link",
      "Let Bento find the cover",
      "Preview and download the image",
    ],
    tips: [
      "Use a direct TikTok video URL or a supported short share link.",
      "Photo-mode posts can expose a different preview than a standard video cover.",
      "If a secure link expires, Bento refreshes it automatically when you select Download.",
    ],
    faqs: [
      {
        question: "Can I paste a short TikTok share link?",
        answer:
          "Yes, when the short URL resolves to a public TikTok video. Removed, region-blocked, age-restricted, or otherwise unavailable posts can still fail.",
      },
      {
        question: "Is the cover generated from a random frame?",
        answer:
          "No. Bento returns the cover image exposed for the public post rather than selecting or inventing a different video frame.",
      },
      {
        question: "Can Bento retrieve friends-only or private TikToks?",
        answer:
          "No. Bento does not sign in to TikTok or bypass private, friends-only, removed, age, or region restrictions.",
      },
    ],
    relatedSlugs: [
      "tiktok-video-downloader",
      "tiktok-to-transcript",
      "short-form-video-script-generator",
    ],
  },
  {
    slug: "youtube-to-transcript",
    name: "Free YouTube video transcript generator",
    shortName: "YouTube transcript",
    description:
      "Paste a public YouTube link and turn the spoken audio into a YouTube transcript you can edit. This video transcript generator does not need existing captions.",
    category: "Media",
    kind: "url-transcript",
    fixedPlatform: "YouTube",
    seoTitle: "YouTube Transcript Generator: Free Video to Text | Bento",
    seoDescription:
      "Paste a public YouTube video or Short for a YouTube transcript. Download TXT, plus SRT or VTT when timed segments are returned. No sign-up.",
    howItWorks: [
      "Copy one public YouTube or Shorts URL",
      "Generate the transcript from the spoken audio",
      "Edit the text, then download TXT, or SRT or VTT when timed",
    ],
    tips: [
      "Use a public watch, Shorts, or youtu.be link. Private and members-only videos are not supported.",
      "Read the YouTube transcript once and fix names, numbers, and specialist terms.",
      "Download SRT or VTT for timed captions, and TXT when you want plain text for posts.",
    ],
    faqs: [
      {
        question: "What is a YouTube transcript?",
        answer:
          "A YouTube transcript is the spoken part of a public video or Short written out as text. Bento creates it from the audio, so you can search, quote, and reuse what was said.",
      },
      {
        question: "How do I use this video transcript generator?",
        answer:
          "Copy a public YouTube or Shorts link, paste it into the tool, and generate the transcript. Review the text, then download TXT, or SRT or VTT when timed segments are available. Schedule and post with Bento when the draft is ready.",
      },
      {
        question: "Does the YouTube video need existing captions?",
        answer:
          "No. Bento transcribes the available spoken audio. A video can still fail when it is private, restricted, unavailable, too long, or contains no clear speech.",
      },
      {
        question: "Can I create transcripts from YouTube Shorts?",
        answer:
          "Yes. Paste a public Shorts URL and Bento will process it through the same transcription flow as a standard YouTube video.",
      },
      {
        question: "Which transcript files can I download?",
        answer:
          "TXT is available for editable copy. SRT and VTT are available when the provider returns timed transcript segments.",
      },
    ],
    relatedSlugs: [
      "youtube-video-downloader",
      "transcript-to-social-post",
      "transcript-to-x-thread",
    ],
    guides: [
      {
        slug: "youtube-video-transcript-generator",
        label: "How to get a YouTube transcript and reuse it",
      },
      {
        slug: "social-media-scheduling-workflow-for-creators",
        label: "How to schedule and post ideas from a transcript",
      },
    ],
  },
  {
    slug: "instagram-to-transcript",
    name: "Free Instagram Reel Transcript Generator",
    shortName: "Instagram transcript",
    description:
      "Convert speech from a public Instagram Reel or video post into editable text and timed captions.",
    category: "Media",
    kind: "url-transcript",
    fixedPlatform: "Instagram",
    seoTitle: "Instagram Reel Transcript Generator: Reels to Text | Bento",
    seoDescription:
      "Turn a public Instagram Reel or video post into editable text with AI. Download TXT, SRT, or VTT captions. Free, no sign-up, no native captions needed.",
    howItWorks: [
      "Paste a public Instagram video link",
      "Create the transcript with AI",
      "Edit or download the result",
    ],
    tips: [
      "Use a direct public Reel or video-post URL rather than a profile link.",
      "Clear voice audio produces more accurate text than music-heavy clips.",
      "Review names, numbers, and quoted language before republishing.",
    ],
    faqs: [
      {
        question: "Does an Instagram Reel need native captions?",
        answer:
          "No. Bento transcribes the available speech from the media itself, so the post does not need an existing caption track.",
      },
      {
        question: "Can Bento transcribe private posts or expired Stories?",
        answer:
          "No. Bento does not sign in to Instagram or bypass access controls. The Reel or video post must be publicly accessible to the provider.",
      },
      {
        question: "What if the post has no clear speech?",
        answer:
          "Music-only, silent, or heavily obscured speech may produce no usable transcript. Bento reports that state instead of inventing text.",
      },
    ],
    relatedSlugs: [
      "instagram-video-downloader",
      "transcript-to-social-post",
      "instagram-caption-generator",
    ],
  },
  {
    slug: "tiktok-to-transcript",
    name: "Free TikTok Transcript Generator",
    shortName: "TikTok transcript",
    description:
      "Turn speech from a public TikTok video into editable text and timed subtitle downloads.",
    category: "Media",
    kind: "url-transcript",
    fixedPlatform: "TikTok",
    seoTitle: "Free TikTok Transcript Generator & Converter | bento.surf",
    seoDescription:
      "Convert a public TikTok video into an editable transcript and download TXT, SRT, or VTT. AI-powered and no sign-up required.",
    howItWorks: [
      "Paste a public TikTok video link",
      "Create the transcript with AI",
      "Edit or download the result",
    ],
    tips: [
      "Use the direct video URL or a supported short TikTok share link.",
      "Voiceovers with clear speech produce better results than music-only videos.",
      "Review names, numbers, and fast-spoken phrases before publishing.",
    ],
    faqs: [
      {
        question: "Can Bento transcribe a TikTok without captions?",
        answer:
          "Yes. Bento transcribes available speech from the media and does not depend on the creator adding native TikTok captions.",
      },
      {
        question: "Do photo-mode and music-only posts work?",
        answer:
          "Photo-mode posts may not expose a video to process, and music-only or silent posts may contain no speech to transcribe.",
      },
      {
        question: "Can Bento transcribe private TikTok videos?",
        answer:
          "No. The video must be public. Bento does not sign in to TikTok or bypass friends-only, private, removed, age, or region restrictions.",
      },
    ],
    relatedSlugs: [
      "tiktok-video-downloader",
      "transcript-to-social-post",
      "tiktok-caption-generator",
    ],
  },
  {
    slug: "audio-to-transcript",
    name: "Free Audio to Transcript Converter",
    shortName: "Audio to transcript",
    description:
      "Upload an audio file and turn spoken words into a timestamped transcript you can download as TXT, SRT, or VTT.",
    category: "Media",
    kind: "transcript",
    seoTitle: "Free AI Audio to Transcript Converter | bento.surf",
    seoDescription:
      "Transcribe MP3, WAV, M4A, WebM audio, OGG, FLAC, or AAC files with AI and download TXT, SRT, or VTT. No sign-up required.",
    howItWorks: ["Choose an audio file", "Transcribe it with AI", "Download TXT, SRT, or VTT"],
    tips: [
      "Use the clearest source recording available and keep music below speech.",
      "Review names, technical terms, and numbers before publishing the transcript.",
      "Use SRT or VTT for timed captions and TXT when you only need editable copy.",
    ],
    faqs: [
      {
        question: "Does Bento keep my audio or transcript?",
        answer:
          "No. The file is sent directly to Bento's configured transcription provider for this request and is not written to Bento storage. The result stays in your browser until you leave or reload the page.",
      },
      {
        question: "Can I paste a YouTube, Instagram, TikTok, or X link?",
        answer:
          "Use Bento's matching YouTube, Instagram, or TikTok transcript tool for a public social-video URL. This audio converter remains the best choice for a supported file you already have.",
      },
      {
        question: "Which files work?",
        answer:
          "The first release accepts MP3, WAV, M4A, WebM audio, OGG, FLAC, and AAC files up to 12 MB. The file picker is limited to audio because this endpoint does not transcode or extract video audio.",
      },
    ],
    relatedSlugs: ["youtube-to-transcript", "transcript-to-social-post", "tiktok-to-transcript"],
  },
  ...platformCaptionTools,
];

export const freeToolsBySlug = new Map(freeTools.map((tool) => [tool.slug, tool]));

const RELATED_TOOL_LIMIT = 6;

/** Explicit related slugs first, then the same category, kind, and platform, up to 6. */
export function relatedFreeTools(tool: FreeTool) {
  const picked: FreeTool[] = [];
  const seen = new Set<string>([tool.slug]);
  const add = (candidate: FreeTool | undefined) => {
    if (!candidate || seen.has(candidate.slug) || picked.length >= RELATED_TOOL_LIMIT) return;
    seen.add(candidate.slug);
    picked.push(candidate);
  };
  for (const slug of tool.relatedSlugs) add(freeToolsBySlug.get(slug));
  const pools = [
    freeTools.filter((item) => item.category === tool.category),
    freeTools.filter((item) => item.kind === tool.kind),
    freeTools.filter((item) => tool.fixedPlatform && item.fixedPlatform === tool.fixedPlatform),
    freeTools,
  ];
  for (const pool of pools) {
    for (const candidate of pool) add(candidate);
  }
  return picked;
}

export const freeToolCategories = ["Media", "Format", "Measure", "Links", "Write"] as const;

const presenceToolSlugs = new Set(["instagram-bio-counter", "linkedin-headline-counter"]);

const schedulerFeatureByPlatform = {
  Instagram: "schedule-instagram-posts",
  LinkedIn: "schedule-linkedin-posts",
  X: "schedule-x-posts",
  Facebook: "schedule-facebook-posts",
  Threads: "schedule-threads-posts",
  TikTok: "schedule-tiktok-posts",
  YouTube: "schedule-youtube-videos",
} as const;

export function freeToolFeatureCta(
  tool: Pick<FreeTool, "category" | "fixedPlatform" | "kind" | "slug">,
) {
  if (
    tool.category === "Links" ||
    tool.kind === "bio" ||
    tool.kind === "headline" ||
    presenceToolSlugs.has(tool.slug)
  ) {
    return {
      featureSlug: "link-in-bio" as const,
      heading: "Put it where people can act.",
      description:
        "Turn the finished identity or campaign link into a creator website that belongs to you.",
      label: "Explore Link in Bio",
    };
  }

  if (tool.fixedPlatform === "Reddit") {
    return {
      featureSlug: "link-in-bio" as const,
      heading: "Give readers a next step.",
      description: "Turn interest from a Reddit post into visits to a creator website you control.",
      label: "Explore Link in Bio",
    };
  }

  if (tool.slug === "youtube-to-transcript") {
    return {
      featureSlug: "social-media-scheduler" as const,
      heading: "Schedule and post with Bento.",
      description:
        "Turn the transcript into posts, then schedule them on the networks Bento supports.",
      label: "Schedule and post with Bento",
    };
  }

  if (tool.fixedPlatform) {
    return {
      featureSlug: schedulerFeatureByPlatform[tool.fixedPlatform],
      heading: "Publish with a plan.",
      description: `Prepare, schedule, and track ${tool.fixedPlatform} content from your Bento workspace.`,
      label: `Explore ${tool.fixedPlatform} scheduling`,
    };
  }

  return {
    featureSlug: "social-media-scheduler" as const,
    heading: "When the post is ready.",
    description: "Schedule it, track the result, and connect the next action to your Bento.",
    label: "Explore Bento scheduling",
  };
}

export function freeToolsForFeature(featureSlug: string) {
  return freeTools
    .filter((tool) => freeToolFeatureCta(tool).featureSlug === featureSlug)
    .slice(0, RELATED_TOOL_LIMIT);
}
