import { isTrustedBrainItem } from "./content-brain";
import type { CreatorDiscoverContext } from "./content-discovery.functions";
import { sourceCreator } from "./content-source-media";
import { creatorMatchesSource, normalizeDiscoverCreator } from "./content-discover-creators";

export type SuggestedDiscoverCreator = {
  id: string;
  name: string;
  profileUrl: string;
  platform: string;
  topics: string[];
  description: string;
  reason: string;
  score: number;
  source: "established" | "brain";
};

export type DiscoverInterestResearch = {
  topics: string[];
  excludedTopics: string[];
  creators: SuggestedDiscoverCreator[];
};

// Topic families connect the user's language to the language used in public posts.
// These are editorial reference profiles, not claims about follower counts or live performance.
const TOPICS = [
  {
    name: "startup journey",
    pattern:
      /\b(startups?|founders?|entrepreneurs?|bootstrapp\w*|solopreneur\w*|saas|build(?:ing)? in public)\b/i,
  },
  {
    name: "writing",
    pattern: /\b(writ\w*|copywrit\w*|storytell\w*|newsletters?)\b/i,
  },
  {
    name: "business growth",
    pattern: /\b(business|sales|marketing|customers?|revenue|offers?|distribution|acquisition)\b/i,
  },
  {
    name: "productivity",
    pattern: /\b(productivity|hustle|habits?|discipline|focus|execution|time management)\b/i,
  },
  {
    name: "product",
    pattern:
      /\b(product management|product design|product led|user research|product-market fit)\b/i,
  },
  {
    name: "AI",
    pattern: /\b(ai|artificial intelligence|machine learning|llms?)\b/i,
  },
  { name: "lifestyle", pattern: /\b(lifestyle|daily vlogs?|everyday life|slow living)\b/i },
  { name: "comedy", pattern: /\b(comedy|comedian\w*|stand[ -]?up|humou?r|sketches|satire)\b/i },
  { name: "fitness", pattern: /\b(fitness|workouts?|bodybuilding|strength training|exercise)\b/i },
  { name: "cooking", pattern: /\b(cooking|recipes?|culinary|baking|chefs?|food)\b/i },
  { name: "fashion", pattern: /\b(fashion|outfits?|streetwear|styling)\b/i },
  { name: "beauty", pattern: /\b(beauty|makeup|skincare|cosmetics)\b/i },
  { name: "travel", pattern: /\b(travel|backpacking|tourism|destinations)\b/i },
  { name: "gaming", pattern: /\b(gaming|gamers?|video games?|esports)\b/i },
  { name: "music", pattern: /\b(music|musicians?|songwriting|guitar|piano|singing)\b/i },
  { name: "science", pattern: /\b(science|physics|chemistry|astronomy|scientific)\b/i },
  { name: "technology", pattern: /\b(technology|gadgets?|smartphones?|tech reviews?)\b/i },
  {
    name: "personal finance",
    pattern: /\b(personal finance|investing|budgeting|financial literacy)\b/i,
  },
  { name: "sports", pattern: /\b(sports?|football|basketball|cricket|soccer|tennis)\b/i },
  { name: "art", pattern: /\b(art|painting|drawing|illustration|sculpture)\b/i },
  { name: "photography", pattern: /\b(photography|photographers?|videography|filmmaking)\b/i },
  { name: "gardening", pattern: /\b(gardening|horticulture|houseplants|permaculture)\b/i },
];
const REFERENCES = [
  {
    name: "Alex Hormozi",
    handle: "AlexHormozi",
    platform: "YouTube",
    topics: ["startup journey", "business growth", "productivity"],
    description: "Direct lessons on offers, sales, business building, and consistent execution.",
  },
  {
    name: "Justin Welsh",
    handle: "thejustinwelsh",
    platform: "X",
    topics: ["writing", "startup journey", "business growth"],
    description:
      "Clear writing, audience building, and practical lessons from a one-person business.",
  },
  {
    name: "Dan Koe",
    handle: "thedankoe",
    platform: "X",
    topics: ["writing", "productivity"],
    description: "Long-form ideas, creative work, and writing as a business.",
  },
  {
    name: "Pieter Levels",
    handle: "levelsio",
    platform: "X",
    topics: ["startup journey", "AI"],
    description: "Building in public, shipping products, and bootstrapping independent businesses.",
  },
  {
    name: "Paul Graham",
    handle: "paulg",
    platform: "X",
    topics: ["startup journey", "writing"],
    description: "Founder thinking and thoughtful essays about startups and making things.",
  },
  {
    name: "Y Combinator",
    handle: "ycombinator",
    platform: "YouTube",
    topics: ["startup journey", "product", "business growth"],
    description:
      "Founder stories and practical guidance on customers, products, and company building.",
  },
  {
    name: "Sahil Bloom",
    handle: "SahilBloom",
    platform: "X",
    topics: ["writing", "productivity"],
    description: "Storytelling, clear frameworks, and lessons on personal growth.",
  },
  {
    name: "Ali Abdaal",
    handle: "aliabdaal",
    platform: "YouTube",
    topics: ["productivity", "writing"],
    description: "Sustainable productivity, creative work, and building a creator business.",
  },
  {
    name: "Lenny Rachitsky",
    handle: "lennysan",
    platform: "X",
    topics: ["product", "business growth", "startup journey"],
    description: "Product strategy, growth, and detailed lessons from experienced operators.",
  },
  {
    name: "Andrej Karpathy",
    handle: "karpathy",
    platform: "X",
    topics: ["AI"],
    description: "Technical explanations and practical perspectives on AI and machine learning.",
  },
  {
    name: "Ethan Mollick",
    handle: "emollick",
    platform: "X",
    topics: ["AI", "productivity"],
    description: "Research-informed examples of using AI in work and learning.",
  },
  {
    name: "Emma Chamberlain",
    handle: "emmachamberlain",
    platform: "YouTube",
    topics: ["lifestyle", "fashion"],
    description: "Personal storytelling, everyday life, and an informal vlog style.",
  },
  {
    name: "Michelle Choi",
    handle: "michellechoii",
    platform: "YouTube",
    topics: ["lifestyle"],
    description: "Everyday routines, home life, and reflective lifestyle vlogs.",
  },
  {
    name: "Trevor Noah",
    handle: "trevornoah",
    platform: "YouTube",
    topics: ["comedy"],
    description: "Stand-up, observational comedy, and storytelling.",
  },
  {
    name: "Lilly Singh",
    handle: "LillySingh",
    platform: "YouTube",
    topics: ["comedy"],
    description: "Character-driven sketches, relatable situations, and comedy.",
  },
  {
    name: "Jeff Nippard",
    handle: "JeffNippard",
    platform: "YouTube",
    topics: ["fitness"],
    description: "Evidence-informed strength training and fitness education.",
  },
  {
    name: "Gordon Ramsay",
    handle: "gordonramsay",
    platform: "YouTube",
    topics: ["cooking"],
    description: "Cooking techniques, recipes, and food demonstrations.",
  },
  {
    name: "Marques Brownlee",
    handle: "mkbhd",
    platform: "YouTube",
    topics: ["technology"],
    description: "Technology reviews, gadgets, and clear product explanations.",
  },
  {
    name: "Mark Rober",
    handle: "MarkRober",
    platform: "YouTube",
    topics: ["science"],
    description: "Science and engineering explained through experiments and builds.",
  },
  {
    name: "NikkieTutorials",
    handle: "nikkietutorials",
    platform: "YouTube",
    topics: ["beauty"],
    description: "Makeup tutorials, transformations, and beauty techniques.",
  },
  {
    name: "Alexa Chung",
    handle: "alexachung",
    platform: "YouTube",
    topics: ["fashion"],
    description: "Personal style, fashion conversations, and the fashion industry.",
  },
  {
    name: "Drew Binsky",
    handle: "drewbinsky",
    platform: "YouTube",
    topics: ["travel"],
    description: "Travel stories focused on people, places, and culture.",
  },
  {
    name: "Markiplier",
    handle: "markiplier",
    platform: "YouTube",
    topics: ["gaming"],
    description: "Gaming playthroughs and personality-led entertainment.",
  },
  {
    name: "Rick Beato",
    handle: "RickBeato",
    platform: "YouTube",
    topics: ["music"],
    description: "Music theory, songwriting analysis, and musician interviews.",
  },
  {
    name: "Ramit Sethi",
    handle: "ramitsethi",
    platform: "YouTube",
    topics: ["personal finance"],
    description: "Personal finance, spending decisions, and money habits.",
  },
  {
    name: "Dude Perfect",
    handle: "dudeperfect",
    platform: "YouTube",
    topics: ["sports"],
    description: "Sports challenges, trick shots, and competitive entertainment.",
  },
  {
    name: "Proko",
    handle: "ProkoTV",
    platform: "YouTube",
    topics: ["art"],
    description: "Drawing lessons, anatomy, and practical art education.",
  },
  {
    name: "Peter McKinnon",
    handle: "PeterMcKinnon",
    platform: "YouTube",
    topics: ["photography"],
    description: "Photography, filmmaking, and visual storytelling techniques.",
  },
  {
    name: "Epic Gardening",
    handle: "epicgardening",
    platform: "YouTube",
    topics: ["gardening"],
    description: "Practical gardening, growing food, and plant care.",
  },
];

export function discoverBrainText(context: CreatorDiscoverContext) {
  if (context.useBrainContext === false) return "";
  return context.brainItems
    .filter(isTrustedBrainItem)
    .map(
      (item) => `${item.title}\n${(item.tags || []).join(" ")}\n${item.content.slice(0, 12_000)}`,
    )
    .join("\n");
}

function topicsIn(text: string) {
  return TOPICS.filter((topic) => topic.pattern.test(text)).map((topic) => topic.name);
}

function positiveBrainText(context: CreatorDiscoverContext) {
  return discoverBrainText(context)
    .split(/[.!?\n]+|\bbut\b/i)
    .filter((sentence) => !/\b(avoid|skip|exclude|never|not|don[’']t|dislike)\b/i.test(sentence))
    .join(" ");
}

export function discoverExcludedTopics(context: CreatorDiscoverContext) {
  if (context.research) return context.research.excludedTopics;
  const excluded = discoverBrainText(context)
    .split(/[.!?\n]+|\bbut\b/i)
    .filter((sentence) =>
      /\b(avoid|exclude|dislike|skip|not interested|not into|don[’']t want)\b/i.test(sentence),
    )
    .join(" ");
  return topicsIn(excluded);
}

// Writing, marketing and productivity can be methods of working in any niche.
// Don't let those incidental mentions displace a clearly stated subject area.
function subjectTopics(topics: string[]) {
  const methods = new Set(["writing", "business growth", "productivity"]);
  const subject = topics.filter((topic) => !methods.has(topic));
  return subject.some((topic) => !["startup journey", "product", "AI"].includes(topic))
    ? subject
    : topics;
}

export function discoverTopicMatches(text: string, topic: string) {
  const family = TOPICS.find((item) => item.name.toLowerCase() === topic.toLowerCase());
  if (family) return family.pattern.test(text);
  const words = (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).join(" ");
  const phrase = (topic.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).join(" ");
  return Boolean(phrase) && ` ${words} `.includes(` ${phrase} `);
}

// These describe presentation or ambition, not a subject. A random challenge or
// creativity hashtag must never qualify a post for a founder/AI audience.
export function isDiscoverSubjectTopic(topic: string) {
  return !/^(?:public )?challenges?$|^(?:creativity|creative|innovation|inspiration|learning|insights?|success|motivation|viral|trending|tips|hustle|strategy|content|growth|journey|style)$/i.test(
    topic.trim(),
  );
}

export function discoverBrainTopics(context: CreatorDiscoverContext) {
  if (context.useBrainContext === false) return [];
  if (context.research) return context.research.topics.filter(isDiscoverSubjectTopic);
  const excluded = discoverExcludedTopics(context);
  const tags = context.brainItems
    .filter(isTrustedBrainItem)
    .flatMap((item) => item.tags || [])
    .map((tag) => tag.trim().toLowerCase())
    .filter(Boolean);
  return subjectTopics(
    [...new Set([...tags, ...topicsIn(positiveBrainText(context))])].filter(
      (topic) => isDiscoverSubjectTopic(topic) && !excluded.includes(topic),
    ),
  ).slice(0, 10);
}

export function suggestDiscoverCreators(
  context: CreatorDiscoverContext,
): SuggestedDiscoverCreator[] {
  const primary = subjectTopics(
    topicsIn((context.research?.topics || context.profile.nicheKeywords).join(" ")),
  );
  const brain = discoverBrainText(context);
  const exclusions = brain
    .split(/[.!?\n]+/)
    .filter((sentence) => /\b(avoid|skip|exclude|never|not|don[’']t|dislike)\b/i.test(sentence))
    .join(" ")
    .toLowerCase();
  const brainTopics = subjectTopics(topicsIn(discoverBrainTopics(context).join(" ")));
  const feedbackTopics = topicsIn(
    context.feedbackSeeds.map((item) => `${item.title} ${item.summary}`).join(" "),
  );
  const followedTopics = topicsIn((context.creators || []).map((item) => item.topics).join(" "));
  const excludedTopics = discoverExcludedTopics(context);
  const references = REFERENCES.flatMap((creator): SuggestedDiscoverCreator[] => {
    if (creator.topics.some((topic) => excludedTopics.includes(topic))) return [];
    const profileUrl =
      creator.platform === "YouTube"
        ? `https://www.youtube.com/@${creator.handle}`
        : `https://www.x.com/${creator.handle}`;
    if (context.creators?.some((follow) => creatorMatchesSource(follow, { authorUrl: profileUrl })))
      return [];
    if (
      exclusions.includes(creator.name.toLowerCase()) ||
      exclusions.includes(creator.handle.toLowerCase())
    )
      return [];
    const namedInBrain =
      brain.toLowerCase().includes(creator.name.toLowerCase()) ||
      new RegExp(`\\b${creator.handle}\\b`, "i").test(brain);
    const matches = creator.topics.filter((topic) => primary.includes(topic));
    const fromBrain = creator.topics.filter((topic) => brainTopics.includes(topic));
    const fromFeedback = creator.topics.filter(
      (topic) => feedbackTopics.includes(topic) || followedTopics.includes(topic),
    );
    if (!matches.length && !fromBrain.length && !namedInBrain) return [];
    const basis = [...new Set([...matches, ...fromBrain, ...fromFeedback])];
    return [
      {
        id: `reference:${creator.handle.toLowerCase()}`,
        name: creator.name,
        profileUrl,
        platform: creator.platform,
        topics: creator.topics,
        description: creator.description,
        score:
          (namedInBrain ? 50 : 0) +
          matches.length * 12 +
          fromBrain.length * 7 +
          fromFeedback.length * 3,
        reason: namedInBrain
          ? "Referenced in your Brain. Explore their approach and public posts."
          : `${fromBrain.length ? "Matches your Brain and interests" : "Matches your interests"}: ${basis.slice(0, 3).join(", ")}.`,
        source: namedInBrain || fromBrain.length ? "brain" : "established",
      },
    ];
  });
  const linked: SuggestedDiscoverCreator[] = [];
  if (context.useBrainContext !== false) {
    for (const item of context.brainItems) {
      if (
        !isTrustedBrainItem(item) ||
        !["inspiration", "link"].includes(item.kind) ||
        !item.sourceUrl
      )
        continue;
      try {
        const creator = normalizeDiscoverCreator(
          sourceCreator(item.sourceUrl)?.url || item.sourceUrl,
        );
        if (exclusions.includes(creator.name.toLowerCase())) continue;
        if (
          context.creators?.some((follow) =>
            creatorMatchesSource(follow, { authorUrl: creator.profileUrl }),
          )
        )
          continue;
        const existing = [...references, ...linked].find((candidate) =>
          creatorMatchesSource(candidate, { authorUrl: creator.profileUrl }),
        );
        if (existing) {
          existing.score += 50;
          existing.source = "brain";
          continue;
        }
        linked.push({
          ...creator,
          id: `brain-reference:${item.id}`,
          topics: topicsIn(`${item.title} ${item.content}`),
          description: "A creator from your saved Brain inspiration.",
          reason: `Saved in your Brain: ${item.title}.`,
          score: 100,
          source: "brain",
        });
      } catch {
        /* Only supported public profile links can become creator suggestions. */
      }
    }
  }
  const researched = (context.research?.creators || []).filter(
    (creator) =>
      !exclusions.includes(creator.name.toLowerCase()) &&
      !context.creators?.some((follow) =>
        creatorMatchesSource(follow, { authorUrl: creator.profileUrl }),
      ),
  );
  const combined = [...researched, ...references, ...linked].sort((a, b) => b.score - a.score);
  return combined
    .filter(
      (creator, index) =>
        !combined
          .slice(0, index)
          .some(
            (prior) =>
              prior.name.toLowerCase() === creator.name.toLowerCase() ||
              creatorMatchesSource(prior, { authorUrl: creator.profileUrl }),
          ),
    )
    .slice(0, 12);
}

export function discoverPersonalizationSignals(context: CreatorDiscoverContext) {
  return {
    excluded: discoverExcludedTopics(context),
    interests:
      context.research?.topics || subjectTopics(topicsIn(context.profile.nicheKeywords.join(" "))),
    brain: discoverBrainTopics(context),
    keywords: context.profile.nicheKeywords,
    saved: topicsIn(context.feedbackSeeds.map((seed) => `${seed.title} ${seed.summary}`).join(" ")),
  };
}

export function scoreDiscoverSource(
  source: {
    title: string;
    summary: string;
    author?: string | null;
    stats?: { views?: number | null; likes?: number | null };
  },
  context: CreatorDiscoverContext,
  signals = discoverPersonalizationSignals(context),
) {
  const text = `${source.title} ${source.summary}`;
  if (signals.excluded.some((topic) => discoverTopicMatches(text, topic)))
    return { score: -100, reason: null };
  const brain = signals.brain.filter((topic) => discoverTopicMatches(text, topic));
  const explicit = signals.keywords.filter((topic) =>
    text.toLowerCase().includes(topic.toLowerCase()),
  );
  const semantic = signals.interests.filter((topic) => discoverTopicMatches(text, topic));
  const savedTopics = signals.saved.filter((topic) => discoverTopicMatches(text, topic));
  const matched = [...new Set([...explicit, ...semantic])];
  // Personal fit dominates. Engagement is only a bounded tie-breaker for relevant posts.
  const fit =
    matched.length * 10 +
    brain.length * 12 +
    (matched.length || brain.length ? savedTopics.length * 3 : 0);
  const quality = fit
    ? Math.min(3, Math.log10(1 + (source.stats?.likes || 0) + (source.stats?.views || 0) / 20))
    : 0;
  return {
    score: fit + quality,
    reason: brain.length
      ? `Matches your Brain: ${brain.join(", ")}.`
      : matched.length
        ? `Matches your topics: ${matched.join(", ")}.`
        : null,
  };
}
