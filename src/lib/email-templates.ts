import { normalizeCustomerCopy, normalizeDashes } from "./text/dashes";
import {
  newsletterContentSchema,
  safeNewsletterUrl,
  type NewsletterContentBlock,
} from "./newsletter";
import {
  resolveNewsletterTemplate,
  type NewsletterTemplatePresentation,
} from "./newsletter-templates";
import {
  DEFAULT_APP_ORIGIN,
  DEFAULT_PUBLIC_ORIGIN,
  configuredPublicOrigin,
} from "./application-urls";
import { getInstancePublicConfig } from "./instance-public-config";

export type BentoEmailCategory = "transactional" | "marketing";

export type BentoEmailEvent =
  | "billing_access_ending"
  | "billing_tools_paused"
  | "billing_page_paused"
  | "workspace_deletion_warning"
  | "workspace_deletion_final"
  | "creator_welcome"
  | "onboarding_quick_win"
  | "commerce_feature"
  | "pro_upgrade"
  | "weekly_digest"
  | "creator_campaign"
  | "newsletter_subscription_confirmation"
  | "creator_lead"
  | "buyer_receipt"
  | "community_invite"
  | "community_update"
  | "creator_sale"
  | "priority_dm_received"
  | "priority_dm_reply"
  | "customer_library_login"
  | "booking_confirmed"
  | "booking_canceled"
  | "booking_reminder"
  | "booking_review_request"
  | "booking_recording_ready"
  | "webinar_reminder"
  | "webinar_replay_ready"
  | "pro_activated"
  | "trial_ending_reminder"
  | "trial_extended"
  | "subscription_cancellation_scheduled"
  | "subscription_paused"
  | "pause_ending_reminder"
  | "payment_failed"
  | "subscription_cancelled"
  | "refund_processed"
  | "social_publish_failed"
  | "social_connection_expired"
  | "content_drafts_ready"
  | "seo_publish_failed";

export type EmailTemplateInput = {
  eventType: BentoEmailEvent;
  category: BentoEmailCategory;
  recipientName?: string | null;
  payload?: Record<string, unknown>;
  appUrl: string;
  publicUrl?: string;
  unsubscribeUrl?: string;
};

export type RenderedEmail = {
  subject: string;
  html: string;
  text: string;
  tags: Array<{ name: string; value: string }>;
};

const BENTO_LOGO_PATH = "/branding/bento-logo.png";

const asText = (value: unknown, fallback = "") =>
  typeof value === "string" && value.trim() ? value.trim() : fallback;
const asNumber = (value: unknown) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
};

function digestPages(payload: Record<string, unknown> | undefined) {
  if (!Array.isArray(payload?.pages)) return [];
  return payload.pages.flatMap((page) => {
    if (!page || typeof page !== "object") return [];
    const record = page as Record<string, unknown>;
    const username = asText(record.username);
    const views = asNumber(record.views);
    return username && views > 0 ? [{ username, views }] : [];
  });
}

function escapeHtml(value: unknown) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

type NewsletterEmailProduct = {
  id: string;
  title: string;
  description?: string | null;
  url: string;
  priceAmount?: number;
  currency?: string;
  billingInterval?: string | null;
};

function newsletterEmailUrl(appUrl: string, value: string) {
  const safe = safeNewsletterUrl(value);
  if (!safe) return null;
  return safe.startsWith("/") ? new URL(safe, appUrl).toString() : safe;
}

export function renderNewsletterEmailDocument(input: {
  appUrl: string;
  content: NewsletterContentBlock[];
  products: NewsletterEmailProduct[];
  presentation?: NewsletterTemplatePresentation;
}) {
  const parsed = newsletterContentSchema.safeParse(input.content);
  if (!parsed.success) throw new Error("Newsletter content is invalid.");
  const blocks = normalizeCustomerCopy(parsed.data);
  const products = new Map(input.products.map((product) => [product.id, product]));
  const html: string[] = [];
  const text: string[] = [];
  const accentColor = input.presentation?.accentColor ?? "#3478f6";
  const headingFont =
    input.presentation?.headingStyle === "sans"
      ? "Arial,sans-serif"
      : "'Instrument Serif',Georgia,serif";
  const blockGap = input.presentation?.density === "compact" ? 14 : 18;

  const style = (block: NewsletterContentBlock) => {
    const value = block.style;
    if (!value) return "";
    return [
      value.backgroundColor ? `background:${value.backgroundColor}` : "",
      value.color ? `color:${value.color}` : "",
      value.padding !== undefined ? `padding:${value.padding}px` : "",
      value.textAlign ? `text-align:${value.textAlign}` : "",
      value.borderRadius !== undefined ? `border-radius:${value.borderRadius}px` : "",
      value.borderColor ? `border-color:${value.borderColor}` : "",
      value.borderWidth !== undefined
        ? `border-width:${value.borderWidth}px;border-style:solid`
        : "",
      value.fontSize !== undefined ? `font-size:${value.fontSize}px` : "",
      value.fontWeight !== undefined ? `font-weight:${value.fontWeight}` : "",
    ]
      .filter(Boolean)
      .join(";");
  };

  const renderBlock = (block: NewsletterContentBlock): { html: string; text: string } => {
    if (block.visibility === "web") return { html: "", text: "" };
    const customStyle = style(block);
    switch (block.type) {
      case "heading":
        return {
          html: `<h2 style="margin:24px 0 0;font-family:${headingFont};font-size:28px;line-height:34px;font-weight:400;color:${accentColor};${customStyle}">${escapeHtml(block.text)}</h2>`,
          text: block.text,
        };
      case "paragraph":
        return {
          html: `<p style="margin:${blockGap}px 0 0;white-space:pre-wrap;font-size:16px;line-height:26px;color:#5f6368;${customStyle}">${escapeHtml(block.text)}</p>`,
          text: block.text,
        };
      case "image": {
        const url = newsletterEmailUrl(input.appUrl, block.url);
        if (!url) return { html: "", text: "" };
        const image = `<img src="${escapeHtml(url)}" alt="${escapeHtml(block.alt)}" style="display:block;width:100%;height:auto;border:0;border-radius:16px">`;
        const href = block.href ? newsletterEmailUrl(input.appUrl, block.href) : null;
        return {
          html: `<div style="margin:22px 0 0;${customStyle}">${href ? `<a href="${escapeHtml(href)}">${image}</a>` : image}${block.caption ? `<p style="margin:7px 0 0;font-size:12px;line-height:18px;color:#737780">${escapeHtml(block.caption)}</p>` : ""}</div>`,
          text: `${block.alt ? `[Image: ${block.alt}]` : "Image"}: ${url}`,
        };
      }
      case "button":
      case "social": {
        const url = newsletterEmailUrl(input.appUrl, block.url);
        if (!url) return { html: "", text: "" };
        const outlined = block.type === "button" && block.variant === "outline";
        const linked =
          block.type === "social" || (block.type === "button" && block.variant === "link");
        return {
          html: `<a href="${escapeHtml(url)}" style="display:inline-block;margin:20px 10px 0 0;padding:${linked ? "9px 0" : "13px 18px"};border-radius:13px;background:${linked || outlined ? "transparent" : accentColor};border:${outlined ? `1px solid ${accentColor}` : "0"};color:${linked || outlined ? accentColor : "#ffffff"};text-decoration:none;font-size:14px;font-weight:700;${customStyle}">${escapeHtml(block.label)}</a>`,
          text: `${block.label}: ${url}`,
        };
      }
      case "divider":
        return {
          html: `<hr style="margin:26px 0 0;border:0;border-top:1px solid #e9e8e4;${customStyle}">`,
          text: "---",
        };
      case "product": {
        const product = products.get(block.productId);
        const url = product && newsletterEmailUrl(input.appUrl, product.url);
        if (!product || !url) return { html: "", text: "" };
        const price =
          typeof product.priceAmount === "number" && product.currency
            ? `${new Intl.NumberFormat("en", {
                style: "currency",
                currency: product.currency.toUpperCase(),
              }).format(
                product.priceAmount / 100,
              )}${product.billingInterval ? ` / ${product.billingInterval}` : ""}`
            : "";
        return {
          html: `<div style="margin:22px 0 0;padding:18px;border:1px solid #e9e8e4;border-radius:16px;${customStyle}"><div style="font-size:16px;font-weight:700;color:#171717">${escapeHtml(product.title)}</div>${product.description ? `<p style="margin:7px 0 0;font-size:14px;line-height:21px;color:#5f6368">${escapeHtml(product.description)}</p>` : ""}${price ? `<p style="margin:7px 0 0;font-size:14px;font-weight:700;color:#171717">${escapeHtml(price)}</p>` : ""}<a href="${escapeHtml(url)}" style="display:inline-block;margin-top:12px;color:${accentColor};text-decoration:none;font-size:14px;font-weight:700">View product</a></div>`,
          text: [product.title, product.description || "", price, `View product: ${url}`]
            .filter(Boolean)
            .join("\n"),
        };
      }
      case "quote":
        return {
          html: `<blockquote style="margin:22px 0 0;padding:18px 20px;border-left:3px solid ${accentColor};font-family:${headingFont};font-size:21px;line-height:29px;color:#272727;${customStyle}">“${escapeHtml(block.text)}”${block.attribution ? `<footer style="margin-top:10px;font-family:Arial,sans-serif;font-size:12px;color:#737780">- ${escapeHtml(block.attribution)}</footer>` : ""}</blockquote>`,
          text: `“${block.text}”${block.attribution ? ` - ${block.attribution}` : ""}`,
        };
      case "list": {
        const tag = block.ordered ? "ol" : "ul";
        return {
          html: `<${tag} style="margin:18px 0 0;padding-left:24px;font-size:16px;line-height:26px;color:#5f6368;${customStyle}">${block.items.map((item) => `<li style="margin:7px 0">${escapeHtml(item)}</li>`).join("")}</${tag}>`,
          text: block.items.join("\n"),
        };
      }
      case "spacer":
        return {
          html: `<div style="height:${block.height}px;line-height:${block.height}px">&nbsp;</div>`,
          text: "",
        };
      case "section": {
        const widths =
          block.layout === "two-left"
            ? ["62%", "38%"]
            : block.layout === "two-right"
              ? ["38%", "62%"]
              : ["50%", "50%"];
        const columns = block.columns.map((column) => column.map(renderBlock));
        return {
          html: `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:22px 0 0;border-collapse:collapse;${customStyle}"><tr>${columns.map((column, index) => `<td width="${widths[index]}" valign="top" style="padding:${index === 0 ? "0 10px 0 0" : "0 0 0 10px"}">${column.map((item) => item.html).join("")}</td>`).join("")}</tr></table>`,
          text: columns
            .flat()
            .map((item) => item.text)
            .filter(Boolean)
            .join("\n\n"),
        };
      }
    }
  };

  for (const block of blocks) {
    const rendered = renderBlock(block);
    html.push(rendered.html);
    text.push(rendered.text);
  }

  return { html: html.join(""), text: text.filter(Boolean).join("\n\n") };
}

function absoluteUrl(appUrl: string, value: unknown, fallbackPath: string) {
  try {
    const base = new URL(appUrl);
    const resolved = new URL(asText(value, fallbackPath), base);
    if (resolved.origin !== base.origin || resolved.protocol !== "https:") {
      return new URL(fallbackPath, base).toString();
    }
    return resolved.toString();
  } catch {
    return new URL(fallbackPath, DEFAULT_APP_ORIGIN).toString();
  }
}

function trustedProfileUrl(value: unknown, publicUrl?: string) {
  const configuredOrigin = configuredPublicOrigin(publicUrl);
  const origin = /^https?:\/\//.test(configuredOrigin) ? configuredOrigin : DEFAULT_PUBLIC_ORIGIN;
  try {
    const url = new URL(asText(value));
    if (url.origin === origin && /^\/@[^/]+\/?$/.test(url.pathname)) {
      return url.toString();
    }
  } catch {
    // Fall through to the configured public origin.
  }
  return origin;
}

function trustedCallUrl(value: unknown, fallback: string) {
  try {
    const url = new URL(asText(value));
    const allowedHosts = ["meet.google.com", "calendar.google.com", "fathom.video"];
    if (url.protocol === "https:" && allowedHosts.some((host) => url.hostname === host)) {
      return url.toString();
    }
  } catch {
    // Fall through to the private Bento destination.
  }
  return fallback;
}

function trustedWebinarUrl(value: unknown, fallback: string) {
  try {
    const url = new URL(asText(value));
    const host = url.hostname.toLowerCase();
    const privateHost =
      host === "localhost" ||
      host.endsWith(".local") ||
      /^127\./.test(host) ||
      /^10\./.test(host) ||
      /^192\.168\./.test(host) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host);
    if (url.protocol === "https:" && !url.username && !url.password && !privateHost) {
      return url.toString();
    }
  } catch {
    // Fall through to the private Bento destination.
  }
  return fallback;
}

function money(amount: unknown, currency: unknown) {
  const code = asText(currency, "USD").toUpperCase();
  try {
    return new Intl.NumberFormat("en", { style: "currency", currency: code }).format(
      asNumber(amount) / 100,
    );
  } catch {
    return `${code} ${(asNumber(amount) / 100).toFixed(2)}`;
  }
}

function templateCopy(input: EmailTemplateInput) {
  const payload = input.payload ?? {};
  const firstName = asText(input.recipientName).split(/\s+/)[0] || "there";
  const dashboard = absoluteUrl(input.appUrl, "/link", "/link");
  const products = absoluteUrl(input.appUrl, "/store?tab=products", "/store?tab=products");
  const settings = absoluteUrl(input.appUrl, "/settings", "/settings");
  const billing = absoluteUrl(input.appUrl, "/settings?section=plan", "/settings?section=plan");
  const accessUrl = absoluteUrl(input.appUrl, payload.accessUrl, "/");
  const productTitle = asText(payload.productTitle, "your purchase");
  const creatorName = asText(payload.creatorName, "the creator");
  const buyerName = asText(payload.buyerName, "A new customer");
  const amount = money(payload.amount, payload.currency);

  switch (input.eventType) {
    case "creator_welcome":
      return {
        subject: "Let’s build your Bento",
        eyebrow: "Welcome to bento.surf",
        title: `Hey ${firstName}, let’s build your storefront.`,
        body: "Connect a social account or tell us about your work. Review your prepared page, Brain and starter drafts, then add a card to begin your three-day trial.",
        cta: "Continue my setup",
        href: absoluteUrl(input.appUrl, "/onboarding", "/onboarding"),
      };
    case "onboarding_quick_win":
      return {
        subject: "Your next step toward a ready Bento",
        eyebrow: "A quick win",
        title: "Start with the one thing you want clicked.",
        body: "Add your strongest link, move it to the top, and publish. A focused Bento beats an unfinished page every time.",
        cta: "Finish my Bento",
        href: dashboard,
      };
    case "commerce_feature":
      return {
        subject: "Turn your Bento into a storefront",
        eyebrow: "Creator commerce",
        title: "Your next block can sell something.",
        body: "Create a digital product, coaching call, course, webinar, or membership and place it directly inside your Bento grid.",
        cta: "Create a product",
        href: products,
      };
    case "pro_upgrade":
      return {
        subject: "Ready to make your Bento fully yours?",
        eyebrow: "Bento plans",
        title: "Custom domains, deeper analytics, more room to grow.",
        body: "Upgrade when you are ready for a branded domain, expanded storage, and the complete creator toolkit.",
        cta: "See my plan",
        href: absoluteUrl(input.appUrl, "/settings?section=plan", "/settings?section=plan"),
      };
    case "weekly_digest": {
      const pages = digestPages(payload);
      const pageSummary = pages.length
        ? `${pages
            .map(
              (page) =>
                `${page.username} (${page.views.toLocaleString()} ${page.views === 1 ? "visit" : "visits"})`,
            )
            .join(", ")}. `
        : "";
      return {
        subject: `Your Bento week: ${asNumber(payload.views).toLocaleString()} visits`,
        eyebrow: "Your weekly Bento",
        title: `${asNumber(payload.views).toLocaleString()} visits · ${asNumber(payload.clicks).toLocaleString()} clicks`,
        body: `${pageSummary}You also made ${asNumber(payload.sales).toLocaleString()} sale${asNumber(payload.sales) === 1 ? "" : "s"}. See where people came from and what they clicked next.`,
        cta: "View analytics",
        href: absoluteUrl(input.appUrl, "/analytics", "/analytics"),
      };
    }
    case "creator_campaign":
      return {
        subject: asText(payload.subject, "An update from a Bento creator"),
        eyebrow: asText(payload.creatorName, "Creator update"),
        title: asText(payload.postTitle, asText(payload.subject, "A new update")),
        body: asText(payload.body, "Open the creator's Bento to learn more."),
        cta: asText(payload.ctaLabel, "Visit creator"),
        href: trustedProfileUrl(payload.creatorUrl, input.publicUrl ?? input.appUrl),
      };
    case "newsletter_subscription_confirmation":
      return {
        subject: `Confirm your subscription to ${asText(payload.publicationTitle, "this newsletter")}`,
        eyebrow: "Confirm subscription",
        title: `One click to subscribe, ${firstName}.`,
        body: `Confirm that you want to receive ${asText(payload.publicationTitle, "this newsletter")}.`,
        cta: "Confirm subscription",
        href: absoluteUrl(input.appUrl, payload.confirmationUrl, "/"),
      };
    case "creator_lead":
      return {
        subject: `New lead for ${productTitle}`,
        eyebrow: "New lead",
        title: `${buyerName} just raised their hand.`,
        body: `${asText(payload.buyerEmail, "A visitor")} submitted your ${productTitle} form. Their answers are waiting in Creator Commerce.`,
        cta: "View the lead",
        href: products,
      };
    case "buyer_receipt":
      return {
        subject: `Your ${productTitle} order is confirmed`,
        eyebrow: "Order confirmed",
        title: `You’re in, ${firstName}.`,
        body: `Your order from ${creatorName} is confirmed${asNumber(payload.amount) > 0 ? ` for ${amount}` : ""}. Keep this email for your records and private access.`,
        cta: asText(payload.accessUrl) ? "Open my purchase" : "View product",
        href: accessUrl,
      };
    case "community_invite":
      return {
        subject: `You’re invited to ${productTitle}`,
        eyebrow: "Community invitation",
        title: `${creatorName} saved you a seat.`,
        body: `You now have private access to ${productTitle}. Open your member space to read updates and join the conversation.`,
        cta: "Open the community",
        href: accessUrl,
      };
    case "community_update":
      return {
        subject: `New in ${productTitle}`,
        eyebrow: "Community update",
        title: `${creatorName} posted a new update.`,
        body: asText(
          payload.preview,
          `Open your private member space to catch up with ${productTitle}.`,
        ),
        cta: "Open my community",
        href: accessUrl,
      };
    case "creator_sale":
      return {
        subject: `You made a sale: ${productTitle}`,
        eyebrow: "New sale 🎉",
        title: `${buyerName} bought ${productTitle}.`,
        body: `${amount} was recorded through ${asText(payload.provider, "your payment provider")}. The order and fees are ready in Creator Commerce.`,
        cta: "View the order",
        href: products,
      };
    case "priority_dm_received":
      return {
        subject: `New priority message from ${buyerName}`,
        eyebrow: "Priority inbox",
        title: `${buyerName} sent a message about ${productTitle}.`,
        body: asText(payload.message, "Open Bento to read the message.").slice(0, 5_000),
        cta: "Open priority inbox",
        href: accessUrl,
      };
    case "priority_dm_reply":
      return {
        subject: `${creatorName} replied to your priority message`,
        eyebrow: "Priority reply",
        title: `${creatorName} replied.`,
        body: asText(payload.reply, "Your reply is ready.").slice(0, 5_000),
        cta: "Open conversation",
        href: accessUrl,
      };
    case "customer_library_login":
      return {
        subject: "Sign in to your Bento library",
        eyebrow: "Your customer library",
        title: `Your purchases are one click away, ${firstName}.`,
        body: `Use this secure link within ${asNumber(payload.expiresInMinutes) || 15} minutes. It signs you in without a password and keeps every Bento purchase in one place.`,
        cta: "Open my library",
        href: accessUrl,
      };
    case "booking_confirmed":
      return {
        subject: `Booking confirmed - ${productTitle}`,
        eyebrow: "Your call is booked",
        title: `${asText(payload.bookingDate, "Your session")} is on the calendar.`,
        body: `${creatorName} and ${asText(payload.buyerName, firstName)} are confirmed. Google Meet details are in this email and the calendar invitation.`,
        cta: "Join Google Meet",
        href: trustedCallUrl(payload.meetingUrl, dashboard),
      };
    case "booking_canceled":
      return {
        subject: `Booking canceled - ${productTitle}`,
        eyebrow: "Schedule updated",
        title: `${asText(payload.bookingDate, "The session")} was canceled.`,
        body: `${asText(payload.buyerName, firstName)} canceled the session with ${creatorName}. The private access page can be used to choose another available time.`,
        cta: "Choose another time",
        href: accessUrl,
      };
    case "booking_reminder":
      return {
        subject: `${asText(payload.reminderLabel, "Reminder")}: ${productTitle}`,
        eyebrow: "Call reminder",
        title: `${productTitle} starts ${asText(payload.startsIn, "soon")}.`,
        body: `${asText(payload.bookingDate, "Your session is coming up")}. Your Google Meet invitation has the same joining details.`,
        cta: "Join Google Meet",
        href: trustedCallUrl(payload.meetingUrl, dashboard),
      };
    case "booking_review_request":
      return {
        subject: `How was your call with ${creatorName}?`,
        eyebrow: "A quick favour",
        title: `How did your ${productTitle} session go?`,
        body: "Share a quick rating and note. It helps the creator improve and helps future customers book with confidence.",
        cta: "Leave a review",
        href: absoluteUrl(input.appUrl, payload.reviewUrl, "/"),
      };
    case "booking_recording_ready":
      return {
        subject: `Your ${productTitle} recording is ready`,
        eyebrow: "Call recording",
        title: "Your recording is ready to watch.",
        body: `Open the private Fathom recording from your call with ${creatorName}. Please keep this link private.`,
        cta: "Watch recording",
        href: trustedCallUrl(payload.recordingUrl, dashboard),
      };
    case "webinar_reminder":
      return {
        subject: `${asText(payload.reminderLabel, "Reminder")}: ${productTitle}`,
        eyebrow: "Webinar reminder",
        title: `${productTitle} starts ${asText(payload.startsIn, "soon")}.`,
        body: `${asText(payload.eventDate, "Your event is coming up")}. The private room opens 15 minutes before the scheduled start.`,
        cta: "Open event room",
        href: trustedWebinarUrl(payload.joinUrl, accessUrl),
      };
    case "webinar_replay_ready":
      return {
        subject: `Replay ready - ${productTitle}`,
        eyebrow: "Webinar replay",
        title: `${productTitle} is ready to watch again.`,
        body: "Your attendee access includes this private replay. Please keep the link for your own use.",
        cta: "Watch replay",
        href: trustedWebinarUrl(payload.replayUrl, accessUrl),
      };
    case "pro_activated":
      return {
        subject: "Your paid Bento plan is active",
        eyebrow: "Plan updated",
        title: "Your creator tools are unlocked.",
        body: "Your subscription was confirmed. Your plan's creator tools, storage, analytics, and custom-domain access are now available.",
        cta: "Explore Bento",
        href: settings,
      };
    case "payment_failed":
      return {
        subject: "Action needed: your Bento payment failed",
        eyebrow: "Billing issue",
        title: "We couldn’t renew your plan.",
        body: "Update your billing details to keep your paid tools and custom domain active. Your page content is still safe.",
        cta: "Fix billing",
        href: absoluteUrl(input.appUrl, "/settings?section=plan", "/settings?section=plan"),
      };
    case "billing_access_ending":
      return {
        subject: "Your Bento workspace needs attention",
        eyebrow: "Workspace access",
        title:
          payload.reason === "past_due"
            ? "Let’s get your payment sorted."
            : "Your workspace’s paid period has ended.",
        body: `${asText(payload.workspaceName, "Your workspace")}: ${payload.reason === "past_due" ? `We couldn’t complete your payment. Creator tools and scheduled activity pause on ${asText(payload.toolsDate)}. Your public page and products go offline on ${asText(payload.publicDate)}.` : "Your public page, products and creator tools are now paused."} Your workspace data is retained until ${asText(payload.deletionDate)}. Renew before then to keep your workspace, or sign in to export your work. Only this unpaid workspace is affected.`,
        cta: "Manage billing",
        href: billing,
      };
    case "billing_tools_paused":
      return {
        subject: "Your Bento creator tools are paused",
        eyebrow: "Payment reminder",
        title: "Your work is saved. Your tools are paused.",
        body: `Scheduling, Auto DMs, Newsletter sending and other creator tools are paused after three days without a successful payment. Your public page and products go offline on ${asText(payload.publicDate)}. Your workspace is scheduled for deletion on ${asText(payload.deletionDate)}. Complete payment to restore access, or sign in to export your work.`,
        cta: "Restore my workspace",
        href: billing,
      };
    case "billing_page_paused":
      return {
        subject: "Your Bento page and products are offline",
        eyebrow: "Workspace paused",
        title: "Bring your page back when you’re ready.",
        body: `Your public page and products are now unavailable after seven days without a successful payment. Your content is retained until ${asText(payload.deletionDate)}. Complete payment to restore access before that date, or sign in to export your work.`,
        cta: "Manage billing",
        href: billing,
      };
    case "workspace_deletion_warning":
    case "workspace_deletion_final":
      return {
        subject:
          input.eventType === "workspace_deletion_warning"
            ? "Your unpaid Bento workspace is due for deletion in 7 days"
            : "Final reminder: your unpaid Bento workspace is due for deletion",
        eyebrow: "90-day retention reminder",
        title: "Please save or restore your workspace.",
        body: `${asText(payload.workspaceName, "Your unpaid workspace")} is scheduled for permanent deletion on ${asText(payload.deletionDate)}, after 90 days without an active paid subscription. Its page, products, Brain, drafts and uploaded files will be removed. Renew or export your work before then. Other workspaces are kept. Your login account is deleted only if no workspaces remain. Order and receipt records may be retained as described in our privacy policy.`,
        cta: "Keep or export my workspace",
        href: billing,
      };
    case "trial_ending_reminder":
      return {
        subject: "Your Bento trial is ending soon",
        eyebrow: "Your trial, your choice",
        title: "A reminder before your first charge.",
        body: `Your Bento trial ends on ${asText(payload.chargeDate)}. Your card will be charged ${amount} per ${payload.billingPeriod === "yearly" ? "year" : "month"} for ${asText(payload.planName, "your chosen plan")} unless you cancel before then. ${asText(payload.taxNote)} How has Bento been so far, and what could we improve? Reply to this email to share your feedback.`,
        cta: "Manage or cancel my plan",
        href: absoluteUrl(input.appUrl, "/settings?section=plan", "/settings?section=plan"),
      };
    case "trial_extended":
      return {
        subject: "Your Bento trial has been extended",
        eyebrow: "More time to try Bento",
        title: "Your trial now lasts seven total days.",
        body: `Your new first-charge date is ${asText(payload.chargeDate)}. We will remind you before then. You can cancel renewal at any time in Billing without an early charge.`,
        cta: "Manage my trial",
        href: billing,
      };
    case "subscription_cancellation_scheduled":
      return {
        subject: "Your Bento renewal is cancelled",
        eyebrow: "Plan update",
        title: "Thank you for building with Bento.",
        body: `Your ${asText(payload.planName, "paid plan")} will not renew. It remains active until ${asText(payload.endDate)}. After that, this workspace’s hosted page, store, and tools pause. You can keep the plan before that date or renew and export your work during the 90-day retention period. Other workspaces are unaffected.`,
        cta: "Review or restart my plan",
        href: billing,
      };
    case "subscription_paused":
      return {
        subject: "Your Bento plan is paused",
        eyebrow: "Plan update",
        title: "Your work is saved while you take a break.",
        body: `Billing is frozen. Your hosted page, store, and creator tools are offline while paused. Automatic resume is scheduled for ${asText(payload.resumeDate)}; we will remind you first. You can resume earlier in Billing. This pause does not start workspace deletion.`,
        cta: "Review or resume my plan",
        href: billing,
      };
    case "pause_ending_reminder":
      return {
        subject: "Your Bento pause ends soon",
        eyebrow: "Upcoming resume",
        title: "Your Bento will be ready again soon.",
        body: `Your paused subscription is scheduled to resume on ${asText(payload.resumeDate)}. Dodo will move your next billing date forward by the time you were paused. Review your plan or resume earlier in Billing.`,
        cta: "Review my plan",
        href: billing,
      };
    case "subscription_cancelled":
      return {
        subject: "Your paid Bento plan has ended",
        eyebrow: "Plan update",
        title: "Your paid plan has ended.",
        body: "Your saved content is safe. Review your billing and access options to continue using Bento, export your work, or explore the self-hosted edition.",
        cta: "Review my plan",
        href: absoluteUrl(input.appUrl, "/settings?section=plan", "/settings?section=plan"),
      };
    case "refund_processed":
      return {
        subject: `Refund processed${productTitle ? ` - ${productTitle}` : ""}`,
        eyebrow: "Refund confirmed",
        title: "The refund has been recorded.",
        body: `${asNumber(payload.amount) > 0 ? amount : "The payment"} was marked as refunded. Bank processing time depends on the payment provider.`,
        cta: "Open Bento",
        href: dashboard,
      };
    case "social_publish_failed":
      return {
        subject: `${asText(payload.provider, "A social network")} could not publish your post`,
        eyebrow: "Scheduler",
        title: "Your post needs attention.",
        body: `${asText(payload.provider, "A connected account")} could not publish “${asText(payload.postTitle, "your scheduled post")}”. ${asText(payload.reason, "Please review the destination in your scheduler.")} Open the scheduler to retry failed destinations or reconnect your account if needed. Posts that were already published will not be sent again.`,
        cta: "Open scheduler",
        href: absoluteUrl(input.appUrl, payload.schedulerUrl, "/post-scheduler"),
      };
    case "seo_publish_failed":
      return {
        subject: `SEO article failed on ${asText(payload.publicationDate, "the scheduled date")}`,
        eyebrow: "Automated SEO",
        title: `Publishing stopped at the ${asText(payload.stage, "unknown")} stage.`,
        body: `Attempt ${Math.max(1, asNumber(payload.attempt))} for ${asText(payload.publicationDate, "the scheduled date")} failed. ${asText(payload.summary, "Open Bento to inspect the run.")}`,
        cta: "Open SEO operations",
        href: absoluteUrl(input.appUrl, "/admin?tab=operations", "/admin?tab=operations"),
      };
    case "social_connection_expired":
      return {
        subject: `Reconnect ${asText(payload.provider, "your social account")}`,
        eyebrow: "Scheduler",
        title: "A social connection needs attention.",
        body: `${asText(payload.provider, "A connected account")} expired or revoked access. Reconnect it before the next scheduled publish.`,
        cta: "Reconnect account",
        href: absoluteUrl(input.appUrl, payload.schedulerUrl, "/post-scheduler"),
      };
    case "content_drafts_ready": {
      const draftCount = Math.max(0, asNumber(payload.draftCount));
      const platforms = Array.isArray(payload.platforms)
        ? payload.platforms
            .map((value) => asText(value))
            .filter(Boolean)
            .slice(0, 8)
        : [];
      const platformText =
        platforms.length > 1
          ? `${platforms.slice(0, -1).join(", ")} and ${platforms.at(-1)}`
          : platforms[0] || "your platforms";
      return {
        subject: `${draftCount} ${draftCount === 1 ? "post is" : "posts are"} ready`,
        eyebrow: "Content Agent",
        title: "Your posts are ready to review.",
        body: `Bento prepared ${draftCount} ${draftCount === 1 ? "draft" : "drafts"} for ${platformText}. Review, edit, and approve them before anything enters your schedule.`,
        cta: "Review drafts",
        href: absoluteUrl(input.appUrl, payload.reviewUrl, "/content?tab=agent"),
      };
    }
  }
}

export function renderBentoEmail(input: EmailTemplateInput): RenderedEmail {
  const raw = templateCopy(input);
  const copy = {
    ...raw,
    subject: normalizeDashes(raw.subject),
    eyebrow: normalizeDashes(raw.eyebrow),
    title: normalizeDashes(raw.title),
    body: normalizeDashes(raw.body),
    cta: normalizeDashes(raw.cta),
  };
  const creatorCampaign = input.eventType === "creator_campaign";
  const instanceName = getInstancePublicConfig(import.meta.env).appName;
  const brandName = creatorCampaign ? asText(input.payload?.creatorName, "Creator") : instanceName;
  const brandLogo =
    (creatorCampaign &&
      newsletterEmailUrl(input.appUrl, asText(input.payload?.newsletterLogoUrl, ""))) ||
    absoluteUrl(input.appUrl, BENTO_LOGO_PATH, BENTO_LOGO_PATH);
  const postalAddress = asText(input.payload?.postalAddress, "").slice(0, 500);
  const newsletterPresentation = resolveNewsletterTemplate(
    input.payload?.newsletterTemplateId,
  )?.presentation;
  const newsletterDocument =
    input.eventType === "creator_campaign" && Array.isArray(input.payload?.newsletterContent)
      ? renderNewsletterEmailDocument({
          appUrl: input.appUrl,
          content: input.payload.newsletterContent as NewsletterContentBlock[],
          products: Array.isArray(input.payload.newsletterProducts)
            ? (input.payload.newsletterProducts as NewsletterEmailProduct[])
            : [],
          presentation: newsletterPresentation,
        })
      : null;
  const footer =
    input.category === "marketing" && input.unsubscribeUrl
      ? `<p style="margin:18px 0 0;font-size:12px;line-height:18px;color:#7b8498">You received this because you subscribed or purchased from this creator. <a href="${escapeHtml(input.unsubscribeUrl)}" style="color:#526078">Unsubscribe</a>.${postalAddress ? `<br>${escapeHtml(postalAddress)}` : ""}</p>`
      : `<p style="margin:18px 0 0;font-size:12px;line-height:18px;color:#7b8498">This is a service email about your Bento account or transaction.${postalAddress ? `<br>${escapeHtml(postalAddress)}` : ""}</p>`;
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="x-apple-disable-message-reformatting">
  <title>${escapeHtml(copy.subject)}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Instrument+Serif&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    @media only screen and (max-width: 620px) {
      .bento-shell { padding: 16px 8px !important; }
      .bento-card { border-radius: 22px !important; }
      .bento-content { padding: 26px 22px !important; }
      .bento-title { font-size: 34px !important; }
      .bento-button { display: block !important; text-align: center !important; }
    }
  </style>
</head>
<body style="margin:0;background:${newsletterPresentation?.backgroundColor ?? "#f7f7f5"};color:#171717;font-family:Inter,ui-sans-serif,-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;-webkit-font-smoothing:antialiased">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent">${escapeHtml(copy.body)}&#847; &#847; &#847; &#847; &#847;</div>
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" class="bento-shell" style="width:100%;background:${newsletterPresentation?.backgroundColor ?? "#f7f7f5"};padding:32px 12px">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" class="bento-card" style="width:100%;max-width:600px;background:#ffffff;border:1px solid #e9e8e4;border-radius:30px;overflow:hidden">
          <tr><td style="height:4px;background:${newsletterPresentation?.accentColor ?? "#2f7cf6"};font-size:0;line-height:0">&nbsp;</td></tr>
          <tr>
            <td class="bento-content" style="padding:36px 38px 34px">
              <table role="presentation" cellspacing="0" cellpadding="0" border="0">
                <tr>
                  <td style="vertical-align:middle;padding-right:12px">
                    <img src="${escapeHtml(brandLogo)}" width="44" height="44" alt="${escapeHtml(brandName)}" style="display:block;width:44px;height:44px;object-fit:cover;border:0;border-radius:12px">
                  </td>
                  <td style="vertical-align:middle;font-family:Inter,ui-sans-serif,-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;font-size:20px;line-height:24px;font-weight:700;letter-spacing:-.04em;color:#171717">${escapeHtml(brandName)}</td>
                </tr>
              </table>
              <div style="margin-top:34px;font-family:Inter,ui-sans-serif,-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;font-size:11px;line-height:16px;font-weight:700;letter-spacing:.16em;text-transform:uppercase;color:#2f7cf6">${escapeHtml(copy.eyebrow)}</div>
              <h1 class="bento-title" style="margin:10px 0 0;font-family:'Instrument Serif',Georgia,'Times New Roman',serif;font-size:42px;line-height:1.03;font-weight:400;letter-spacing:-.025em;color:#171717">${escapeHtml(copy.title)}</h1>
              ${newsletterDocument ? newsletterDocument.html : `<p style="margin:20px 0 0;font-family:Inter,ui-sans-serif,-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;font-size:16px;line-height:26px;font-weight:400;color:#5f6368">${escapeHtml(copy.body)}</p><a class="bento-button" href="${escapeHtml(copy.href)}" style="display:inline-block;margin-top:28px;padding:14px 20px;border-radius:14px;background:#171717;color:#ffffff;text-decoration:none;font-family:Inter,ui-sans-serif,-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;font-size:14px;line-height:20px;font-weight:700">${escapeHtml(copy.cta)}</a>`}
              <div style="height:1px;background:#ecebe7;margin:34px 0 0"></div>
              ${footer}
              <p style="margin:10px 0 0;font-family:Inter,ui-sans-serif,-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;font-size:12px;line-height:18px;color:#9a9a96">© bento.surf</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
  const text = newsletterDocument
    ? `${copy.eyebrow}\n\n${copy.title}\n\n${newsletterDocument.text}${input.category === "marketing" && input.unsubscribeUrl ? `\n\nUnsubscribe: ${input.unsubscribeUrl}` : ""}${postalAddress ? `\n${postalAddress}` : ""}\n\n- bento.surf`
    : `${copy.eyebrow}\n\n${copy.title}\n\n${copy.body}\n\n${copy.cta}: ${copy.href}${input.category === "marketing" && input.unsubscribeUrl ? `\n\nUnsubscribe: ${input.unsubscribeUrl}` : ""}${postalAddress ? `\n${postalAddress}` : ""}\n\n- bento.surf`;
  return {
    subject: copy.subject,
    html,
    text,
    tags: [
      { name: "event", value: input.eventType.replace(/[^a-z0-9_-]/gi, "_").slice(0, 256) },
      { name: "category", value: input.category },
    ],
  };
}
