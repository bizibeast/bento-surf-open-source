// Central registry of supported platforms. Used by the add-block picker,
// edit forms, public renderer, and onboarding. To add a platform, append
// an entry here - every consumer picks it up automatically.

import type { ComponentType, SVGProps } from "react";
import {
  SiX,
  SiInstagram,
  SiThreads,
  SiTiktok,
  SiFacebook,
  SiPinterest,
  SiReddit,
  SiBluesky,
  SiMastodon,
  SiDiscord,
  SiTelegram,
  SiWhatsapp,
  SiSnapchat,
  SiYoutube,
  SiVimeo,
  SiTwitch,
  SiLoom,
  SiSpotify,
  SiApplemusic,
  SiSoundcloud,
  SiBandcamp,
  SiGithub,
  SiGitlab,
  SiStackoverflow,
  SiProducthunt,
  SiDribbble,
  SiBehance,
  SiMedium,
  SiSubstack,
  SiDevdotto,
  SiNotion,
  SiGumroad,
  SiEtsy,
  SiKofi,
  SiBuymeacoffee,
  SiPaypal,
  SiPatreon,
  SiCalendly,
} from "react-icons/si";
import {
  Phone,
  Mail,
  Globe,
  MapPin,
  Image as ImageIcon,
  Video,
  Music2,
  Quote,
  Link as LinkIcon,
  Calendar,
  Plus,
  Type,
  Briefcase,
  PackageOpen,
  MessagesSquare,
  Send,
  GraduationCap,
  Radio,
  UsersRound,
  Repeat2,
  Wrench,
  ClipboardList,
  BadgePercent,
  Code2,
} from "lucide-react";

import { FaLinkedin } from "react-icons/fa6";
import { FigmaColor } from "@/components/icons/FigmaColor";

export type PlatformCategory =
  | "social"
  | "video"
  | "music"
  | "dev"
  | "design"
  | "writing"
  | "shop"
  | "contact"
  | "monetize"
  | "custom";

/** Icons may come from lucide-react or react-icons; both render as SVG with className. */
export type PlatformIcon = ComponentType<
  SVGProps<SVGSVGElement> & { size?: number | string; strokeWidth?: number }
>;

export type PlatformDef = {
  key: string;
  label: string;
  icon: PlatformIcon;
  category: PlatformCategory;
  /** Brand color used for the icon chip + pill CTA. Hex or CSS gradient. */
  color: string;
  /** Text color on the brand pill */
  fg?: string;
  /** Optional pastel tint background (CSS color). Defaults to color-mixed brand. */
  tint?: string;
  /** Label for the action pill on the tile */
  cta?: string;
  /** When set, `${urlBase}${handle}` becomes the link */
  urlBase?: string;
  /** Placeholder shown in the handle/url input */
  placeholder?: string;
  /** Maps to BlockRenderer behavior */
  blockType:
    | "social_link"
    | "generic_link"
    | "contact"
    | "video"
    | "spotify"
    | "audio"
    | "link_preview"
    | "image"
    | "map"
    | "heading"
    | "quote"
    | "experience"
    | "email_capture"
    | "commerce";
  /** Default content for new block */
  defaults?: PlatformDefaults;
};

// Provider defaults are deliberately polymorphic and are normalized by the
// block editor before persistence.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type PlatformDefaults = Record<string, any>;

export const PLATFORMS: PlatformDef[] = [
  // MONETISE
  {
    key: "digital_product",
    label: "Digital product",
    icon: PackageOpen,
    category: "monetize",
    color: "#3478f6",
    fg: "#fff",
    blockType: "commerce",
    defaults: { productKind: "digital_product" },
  },
  {
    key: "coaching_call",
    label: "Coaching call",
    icon: MessagesSquare,
    category: "monetize",
    color: "#8067e8",
    fg: "#fff",
    blockType: "commerce",
    defaults: { productKind: "coaching_call" },
  },
  {
    key: "priority_dm",
    label: "Priority DM",
    icon: Send,
    category: "monetize",
    color: "#3478f6",
    fg: "#fff",
    blockType: "commerce",
    defaults: { productKind: "priority_dm" },
  },
  {
    key: "course",
    label: "e-Course",
    icon: GraduationCap,
    category: "monetize",
    color: "#f1a900",
    fg: "#17213a",
    blockType: "commerce",
    defaults: { productKind: "course" },
  },
  {
    key: "webinar",
    label: "Webinar",
    icon: Radio,
    category: "monetize",
    color: "#ff5f6d",
    fg: "#fff",
    blockType: "commerce",
    defaults: { productKind: "webinar" },
  },
  {
    key: "paid_community",
    label: "Paid community",
    icon: UsersRound,
    category: "monetize",
    color: "#24a56a",
    fg: "#fff",
    blockType: "commerce",
    defaults: { productKind: "paid_community" },
  },
  {
    key: "membership",
    label: "Membership",
    icon: Repeat2,
    category: "monetize",
    color: "#1f8bff",
    fg: "#fff",
    blockType: "commerce",
    defaults: { productKind: "membership" },
  },
  {
    key: "custom_product",
    label: "Custom product",
    icon: Wrench,
    category: "monetize",
    color: "#17213a",
    fg: "#fff",
    blockType: "commerce",
    defaults: { productKind: "custom_product" },
  },
  {
    key: "lead_form",
    label: "Emails / applications",
    icon: ClipboardList,
    category: "monetize",
    color: "#9a71e8",
    fg: "#fff",
    blockType: "commerce",
    defaults: { productKind: "lead_form" },
  },
  {
    key: "email_capture",
    label: "Newsletter signup",
    icon: Mail,
    category: "monetize",
    color: "#3478f6",
    fg: "#fff",
    blockType: "email_capture",
    defaults: {
      title: "Join my newsletter",
      subtitle: "Get new posts in your inbox.",
      buttonLabel: "Join",
      tint: "sky",
    },
  },
  {
    key: "bento_affiliate",
    label: "Bento affiliate",
    icon: BadgePercent,
    category: "monetize",
    color: "#ffc928",
    fg: "#17213a",
    blockType: "commerce",
    defaults: { productKind: "bento_affiliate" },
  },

  // SOCIAL
  {
    key: "twitter",
    label: "X (Twitter)",
    icon: SiX,
    category: "social",
    color: "#000",
    fg: "#fff",
    urlBase: "https://x.com/",
    placeholder: "username",
    blockType: "social_link",
  },
  {
    key: "instagram",
    label: "Instagram",
    icon: SiInstagram,
    category: "social",
    color: "linear-gradient(135deg,#f9ce34,#ee2a7b,#6228d7)",
    fg: "#fff",
    urlBase: "https://instagram.com/",
    placeholder: "username",
    blockType: "social_link",
  },
  {
    key: "threads",
    label: "Threads",
    icon: SiThreads,
    category: "social",
    color: "#000",
    fg: "#fff",
    urlBase: "https://threads.net/@",
    placeholder: "username",
    blockType: "social_link",
  },
  {
    key: "tiktok",
    label: "TikTok",
    icon: SiTiktok,
    category: "social",
    color: "#000",
    fg: "#fff",
    urlBase: "https://tiktok.com/@",
    placeholder: "username",
    blockType: "social_link",
  },
  {
    key: "linkedin",
    label: "LinkedIn",
    icon: FaLinkedin,
    category: "social",
    color: "#0a66c2",
    fg: "#fff",
    urlBase: "https://linkedin.com/in/",
    placeholder: "username",
    blockType: "social_link",
  },
  {
    key: "facebook",
    label: "Facebook",
    icon: SiFacebook,
    category: "social",
    color: "#1877f2",
    fg: "#fff",
    urlBase: "https://facebook.com/",
    placeholder: "username",
    blockType: "social_link",
  },
  {
    key: "pinterest",
    label: "Pinterest",
    icon: SiPinterest,
    category: "social",
    color: "#bd081c",
    fg: "#fff",
    urlBase: "https://pinterest.com/",
    placeholder: "username",
    blockType: "social_link",
  },
  {
    key: "reddit",
    label: "Reddit",
    icon: SiReddit,
    category: "social",
    color: "#ff4500",
    fg: "#fff",
    urlBase: "https://reddit.com/user/",
    placeholder: "username",
    blockType: "social_link",
  },
  {
    key: "bluesky",
    label: "Bluesky",
    icon: SiBluesky,
    category: "social",
    color: "#0085ff",
    fg: "#fff",
    urlBase: "https://bsky.app/profile/",
    placeholder: "you.bsky.social",
    blockType: "social_link",
  },
  {
    key: "mastodon",
    label: "Mastodon",
    icon: SiMastodon,
    category: "social",
    color: "#6364ff",
    fg: "#fff",
    urlBase: "https://mastodon.social/@",
    placeholder: "username",
    blockType: "social_link",
  },
  {
    key: "discord",
    label: "Discord",
    icon: SiDiscord,
    category: "social",
    color: "#5865f2",
    fg: "#fff",
    urlBase: "https://discord.gg/",
    placeholder: "invite code",
    blockType: "social_link",
  },
  {
    key: "telegram",
    label: "Telegram",
    icon: SiTelegram,
    category: "social",
    color: "#26a5e4",
    fg: "#fff",
    urlBase: "https://t.me/",
    placeholder: "username",
    blockType: "social_link",
  },
  {
    key: "whatsapp",
    label: "WhatsApp",
    icon: SiWhatsapp,
    category: "social",
    color: "#25d366",
    fg: "#fff",
    urlBase: "https://wa.me/",
    placeholder: "1234567890",
    blockType: "social_link",
  },
  {
    key: "snapchat",
    label: "Snapchat",
    icon: SiSnapchat,
    category: "social",
    color: "#fffc00",
    fg: "#000",
    urlBase: "https://snapchat.com/add/",
    placeholder: "username",
    blockType: "social_link",
  },

  // VIDEO
  {
    key: "youtube",
    label: "YouTube",
    icon: SiYoutube,
    category: "social",
    color: "#ff0000",
    fg: "#fff",
    urlBase: "https://youtube.com/@",
    placeholder: "channel",
    blockType: "social_link",
  },
  {
    key: "youtube_embed",
    label: "YouTube video",
    icon: SiYoutube,
    category: "video",
    color: "#ff0000",
    fg: "#fff",
    placeholder: "https://youtu.be/...",
    blockType: "video",
    defaults: { embedProvider: "youtube" },
  },
  {
    key: "youtube_recent",
    label: "Recent YouTube video",
    icon: SiYoutube,
    category: "video",
    color: "#ff0000",
    fg: "#fff",
    placeholder: "@GoogleDevelopers",
    blockType: "video",
    defaults: { liveProvider: "youtube" },
  },
  {
    key: "instagram_video",
    label: "Instagram video",
    icon: SiInstagram,
    category: "video",
    color: "linear-gradient(135deg,#f9ce34,#ee2a7b,#6228d7)",
    fg: "#fff",
    placeholder: "https://instagram.com/reel/...",
    blockType: "video",
    defaults: { embedProvider: "instagram" },
  },
  {
    key: "tiktok_video",
    label: "TikTok video",
    icon: SiTiktok,
    category: "video",
    color: "#000",
    fg: "#fff",
    placeholder: "https://tiktok.com/@creator/video/...",
    blockType: "video",
    defaults: { embedProvider: "tiktok" },
  },
  {
    key: "twitter_post",
    label: "X post / Tweet",
    icon: SiX,
    category: "social",
    color: "#000",
    fg: "#fff",
    placeholder: "https://x.com/creator/status/...",
    blockType: "video",
    defaults: { embedProvider: "twitter", twitterTheme: "light" },
  },
  {
    key: "vimeo",
    label: "Vimeo",
    icon: SiVimeo,
    category: "video",
    color: "#1ab7ea",
    fg: "#fff",
    placeholder: "https://vimeo.com/...",
    blockType: "video",
    defaults: {},
  },
  {
    key: "twitch",
    label: "Twitch",
    icon: SiTwitch,
    category: "video",
    color: "#9146ff",
    fg: "#fff",
    urlBase: "https://twitch.tv/",
    placeholder: "username",
    blockType: "social_link",
  },
  {
    key: "loom",
    label: "Loom",
    icon: SiLoom,
    category: "video",
    color: "#625df5",
    fg: "#fff",
    placeholder: "https://loom.com/share/...",
    blockType: "video",
    defaults: {},
  },

  // MUSIC
  {
    key: "spotify",
    label: "Spotify",
    icon: SiSpotify,
    category: "music",
    color: "#1db954",
    fg: "#fff",
    placeholder: "https://open.spotify.com/embed/...",
    blockType: "spotify",
    defaults: {},
  },
  {
    key: "apple_music",
    label: "Apple Music",
    icon: SiApplemusic,
    category: "music",
    color: "#fa243c",
    fg: "#fff",
    placeholder: "https://music.apple.com/...",
    blockType: "audio",
    defaults: {},
  },
  {
    key: "soundcloud",
    label: "SoundCloud",
    icon: SiSoundcloud,
    category: "music",
    color: "#ff5500",
    fg: "#fff",
    placeholder: "https://soundcloud.com/...",
    blockType: "audio",
    defaults: {},
  },
  {
    key: "bandcamp",
    label: "Bandcamp",
    icon: SiBandcamp,
    category: "music",
    color: "#629aa9",
    fg: "#fff",
    urlBase: "https://bandcamp.com/",
    placeholder: "username",
    blockType: "social_link",
  },

  // DEV
  {
    key: "github",
    label: "GitHub",
    icon: SiGithub,
    category: "dev",
    color: "#0f172a",
    fg: "#fff",
    urlBase: "https://github.com/",
    placeholder: "username",
    blockType: "social_link",
  },
  {
    key: "gitlab",
    label: "GitLab",
    icon: SiGitlab,
    category: "dev",
    color: "#fc6d26",
    fg: "#fff",
    urlBase: "https://gitlab.com/",
    placeholder: "username",
    blockType: "social_link",
  },
  {
    key: "stackoverflow",
    label: "Stack Overflow",
    icon: SiStackoverflow,
    category: "dev",
    color: "#f48024",
    fg: "#fff",
    urlBase: "https://stackoverflow.com/users/",
    placeholder: "user id",
    blockType: "social_link",
  },
  {
    key: "codepen",
    label: "CodePen",
    icon: Code2,
    category: "dev",
    color: "#000",
    fg: "#fff",
    urlBase: "https://codepen.io/",
    placeholder: "username",
    blockType: "social_link",
  },
  {
    key: "producthunt",
    label: "Product Hunt",
    icon: SiProducthunt,
    category: "dev",
    color: "#da552f",
    fg: "#fff",
    urlBase: "https://producthunt.com/@",
    placeholder: "username",
    blockType: "social_link",
  },

  // DESIGN
  {
    key: "dribbble",
    label: "Dribbble",
    icon: SiDribbble,
    category: "design",
    color: "#ea4c89",
    fg: "#fff",
    urlBase: "https://dribbble.com/",
    placeholder: "username",
    blockType: "social_link",
  },
  {
    key: "behance",
    label: "Behance",
    icon: SiBehance,
    category: "design",
    color: "#1769ff",
    fg: "#fff",
    urlBase: "https://behance.net/",
    placeholder: "username",
    blockType: "social_link",
  },
  {
    key: "figma",
    label: "Figma",
    icon: FigmaColor,
    category: "design",
    color: "#1e1e1e",
    fg: "#fff",
    urlBase: "https://figma.com/@",
    placeholder: "username",
    blockType: "social_link",
  },

  // WRITING
  {
    key: "medium",
    label: "Medium",
    icon: SiMedium,
    category: "writing",
    color: "#000",
    fg: "#fff",
    urlBase: "https://medium.com/@",
    placeholder: "username",
    blockType: "social_link",
  },
  {
    key: "substack",
    label: "Substack",
    icon: SiSubstack,
    category: "writing",
    color: "#ff6719",
    fg: "#fff",
    urlBase: "https://",
    placeholder: "you.substack.com",
    blockType: "social_link",
  },
  {
    key: "devto",
    label: "Dev.to",
    icon: SiDevdotto,
    category: "writing",
    color: "#0a0a0a",
    fg: "#fff",
    urlBase: "https://dev.to/",
    placeholder: "username",
    blockType: "social_link",
  },
  {
    key: "notion",
    label: "Notion page",
    icon: SiNotion,
    category: "writing",
    color: "#000",
    fg: "#fff",
    placeholder: "https://notion.so/...",
    blockType: "generic_link",
    defaults: { title: "Notion" },
  },

  // SHOP / PAY
  {
    key: "gumroad",
    label: "Gumroad",
    icon: SiGumroad,
    category: "shop",
    color: "#ff90e8",
    fg: "#000",
    urlBase: "https://gumroad.com/",
    placeholder: "username",
    blockType: "social_link",
  },
  {
    key: "etsy",
    label: "Etsy",
    icon: SiEtsy,
    category: "shop",
    color: "#f1641e",
    fg: "#fff",
    urlBase: "https://etsy.com/shop/",
    placeholder: "shopname",
    blockType: "social_link",
  },
  {
    key: "kofi",
    label: "Ko-fi",
    icon: SiKofi,
    category: "shop",
    color: "#ff5e5b",
    fg: "#fff",
    urlBase: "https://ko-fi.com/",
    placeholder: "username",
    blockType: "social_link",
  },
  {
    key: "bmac",
    label: "Buy Me a Coffee",
    icon: SiBuymeacoffee,
    category: "shop",
    color: "#ffdd00",
    fg: "#000",
    urlBase: "https://buymeacoffee.com/",
    placeholder: "username",
    blockType: "social_link",
  },
  {
    key: "paypal",
    label: "PayPal.me",
    icon: SiPaypal,
    category: "shop",
    color: "#003087",
    fg: "#fff",
    urlBase: "https://paypal.me/",
    placeholder: "username",
    blockType: "social_link",
  },
  {
    key: "patreon",
    label: "Patreon",
    icon: SiPatreon,
    category: "shop",
    color: "#ff424d",
    fg: "#fff",
    urlBase: "https://patreon.com/",
    placeholder: "username",
    blockType: "social_link",
  },

  // CONTACT
  {
    key: "email",
    label: "Email",
    icon: Mail,
    category: "contact",
    color: "#475569",
    fg: "#fff",
    placeholder: "you@example.com",
    blockType: "contact",
    defaults: { kind: "email" },
  },
  {
    key: "phone",
    label: "Phone",
    icon: Phone,
    category: "contact",
    color: "#0f766e",
    fg: "#fff",
    placeholder: "+1 555 123 4567",
    blockType: "contact",
    defaults: { kind: "phone" },
  },
  {
    key: "calendly",
    label: "Calendly",
    icon: SiCalendly,
    category: "contact",
    color: "#006bff",
    fg: "#fff",
    urlBase: "https://calendly.com/",
    placeholder: "username",
    blockType: "social_link",
  },
  {
    key: "savvycal",
    label: "SavvyCal",
    icon: Calendar,
    category: "contact",
    color: "#101010",
    fg: "#fff",
    urlBase: "https://savvycal.com/",
    placeholder: "username",
    blockType: "social_link",
  },
  {
    key: "website",
    label: "Personal site",
    icon: Globe,
    category: "contact",
    color: "#0f172a",
    fg: "#fff",
    placeholder: "https://...",
    blockType: "generic_link",
    defaults: { title: "Website" },
  },

  // CUSTOM (pinned at top of picker UI)
  {
    key: "custom_link",
    label: "Custom link",
    icon: Plus,
    category: "custom",
    color: "#1f2937",
    fg: "#fff",
    placeholder: "https://...",
    blockType: "generic_link",
    defaults: { title: "" },
  },
  {
    key: "custom_image",
    label: "Image",
    icon: ImageIcon,
    category: "custom",
    color: "linear-gradient(135deg,#6ea8ff,#9c7cff,#ff8bb3)",
    fg: "#fff",
    blockType: "image",
    defaults: { mediaKind: "image" },
  },
  {
    key: "custom_video",
    label: "Video",
    icon: Video,
    category: "custom",
    color: "linear-gradient(135deg,#3478f6,#8067e8)",
    fg: "#fff",
    blockType: "video",
    defaults: { mediaKind: "video" },
  },
  {
    key: "custom_audio",
    label: "Audio",
    icon: Music2,
    category: "custom",
    color: "linear-gradient(135deg,#8067e8,#ff6f91)",
    fg: "#fff",
    blockType: "audio",
    defaults: { mediaKind: "audio" },
  },
  {
    key: "quote",
    label: "Quote",
    icon: Quote,
    category: "custom",
    color: "#8067e8",
    fg: "#fff",
    placeholder: "Words worth sharing",
    blockType: "quote",
    defaults: { text: "", author: "" },
  },
  {
    key: "map",
    label: "Location",
    icon: MapPin,
    category: "custom",
    color: "#3478f6",
    fg: "#fff",
    placeholder: "City, landmark, or address",
    blockType: "map",
    defaults: { title: "" },
  },
  {
    key: "custom_widget",
    label: "Embed widget",
    icon: LinkIcon,
    category: "custom",
    color: "#ff4e50",
    fg: "#fff",
    placeholder: "https://... or <iframe ...>",
    blockType: "generic_link",
    defaults: { title: "Widget" },
  },
  {
    key: "heading",
    label: "Heading / Text",
    icon: Type,
    category: "custom",
    color: "#0f172a",
    fg: "#fff",
    placeholder: "Your heading",
    blockType: "heading",
    defaults: { text: "" },
  },
  {
    key: "experience",
    label: "Experience",
    icon: Briefcase,
    category: "custom",
    color: "#0f172a",
    fg: "#fff",
    placeholder: "Company",
    blockType: "experience",
    defaults: { items: [] },
  },
];

export const CATEGORIES: { key: PlatformCategory; label: string }[] = [
  { key: "custom", label: "Custom" },
  { key: "monetize", label: "Sell & Grow" },
  { key: "social", label: "Social" },
  { key: "video", label: "Video" },
  { key: "music", label: "Music" },
  { key: "dev", label: "Developer" },
  { key: "design", label: "Design" },
  { key: "writing", label: "Writing" },
  { key: "shop", label: "Shop & Tips" },
  { key: "contact", label: "Contact" },
];

export function findPlatform(key: string): PlatformDef | undefined {
  return PLATFORMS.find((p) => p.key === key);
}

/** Convert YouTube/Vimeo/Loom share URLs to an embed URL. */
export function toEmbedUrl(url: string): string {
  try {
    const u = new URL(url);
    // YouTube
    if (u.hostname.includes("youtube.com") && u.searchParams.get("v")) {
      return `https://www.youtube.com/embed/${u.searchParams.get("v")}`;
    }
    if (u.hostname === "youtu.be") {
      return `https://www.youtube.com/embed${u.pathname}`;
    }
    if (u.hostname.includes("youtube.com") && u.pathname.startsWith("/shorts/")) {
      return `https://www.youtube.com/embed/${u.pathname.split("/")[2]}`;
    }
    // Vimeo
    if (u.hostname.includes("vimeo.com")) {
      const id = u.pathname.split("/").filter(Boolean)[0];
      if (id) return `https://player.vimeo.com/video/${id}`;
    }
    // Loom
    if (u.hostname.includes("loom.com") && u.pathname.startsWith("/share/")) {
      return url.replace("/share/", "/embed/");
    }
    return url;
  } catch {
    return url;
  }
}
