import { afterEach, describe, expect, it } from "vitest";
import { renderBentoEmail, renderNewsletterEmailDocument } from "./email-templates";
import {
  createAudienceUnsubscribeToken,
  createEmailPreferenceToken,
  createNewsletterConfirmationToken,
  createNewsletterUnsubscribeToken,
  prepareEmailPayloadForDelivery,
  normalizeEmailRecipient,
  resolveEmailDeliveryEnvelope,
  verifyEmailPreferenceToken,
  verifyNewsletterConfirmationToken,
} from "./email.server";
import { handleEmailUnsubscribeRequest } from "./email.server";

const originalAppUrl = process.env.VITE_APP_URL;
afterEach(() => {
  if (originalAppUrl === undefined) Reflect.deleteProperty(process.env, "VITE_APP_URL");
  else process.env.VITE_APP_URL = originalAppUrl;
});

describe("Bento email templates", () => {
  it("builds the default brand asset from the configured instance origin", () => {
    const email = renderBentoEmail({
      eventType: "buyer_receipt",
      category: "transactional",
      payload: { productTitle: "Guide" },
      appUrl: "https://self.example",
    });

    expect(email.html).toContain("https://self.example/branding/bento-logo.png");
    expect(email.html).not.toContain("https://bento.surf");
  });

  it("renders all seven newsletter blocks while omitting unresolved products and unsafe HTML", () => {
    const document = renderNewsletterEmailDocument({
      appUrl: "https://app.bento.surf",
      content: [
        { id: "1", type: "heading", text: "<Launch>" },
        { id: "2", type: "paragraph", text: "News <script>alert(1)</script>" },
        { id: "3", type: "image", url: "https://cdn.example.com/cover.png", alt: "Cover" },
        { id: "4", type: "button", label: "Read", url: "/newsletter/launch" },
        { id: "5", type: "divider" },
        { id: "6", type: "product", productId: "11111111-1111-4111-8111-111111111111" },
        { id: "7", type: "social", label: "Follow", url: "https://social.example/ari" },
        { id: "8", type: "product", productId: "22222222-2222-4222-8222-222222222222" },
      ],
      products: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          title: "Creator Kit",
          description: "Published product",
          url: "https://bento.surf/@ari/products/creator-kit",
        },
      ],
    });

    expect(document.html).toContain("&lt;Launch&gt;");
    expect(document.html).not.toContain("<script>");
    expect(document.html).toContain("https://cdn.example.com/cover.png");
    expect(document.html).toContain("https://app.bento.surf/newsletter/launch");
    expect(document.html).toContain("<hr");
    expect(document.html).toContain("Creator Kit");
    expect(document.html).not.toContain("22222222-2222-4222-8222-222222222222");
    expect(document.text).toContain("Follow: https://social.example/ari");
  });

  it("uses the structured document for delivered newsletter campaigns", () => {
    const email = renderBentoEmail({
      eventType: "creator_campaign",
      category: "marketing",
      payload: {
        subject: "Studio Notes",
        postTitle: "A week inside the studio",
        creatorName: "Ari",
        creatorUrl: "https://public.example/@ari",
        newsletterLogoUrl: "https://cdn.example.com/studio-notes.png",
        newsletterContent: [
          { id: "1", type: "heading", text: "Launch notes" },
          { id: "2", type: "paragraph", text: "The full structured issue." },
        ],
        newsletterProducts: [],
        newsletterTemplateId: "personal-note",
        postalAddress: '<script>alert("postal")</script> 123 Studio Road',
      },
      appUrl: "https://app.example",
      publicUrl: "https://public.example",
      unsubscribeUrl: "https://app.example/api/email/unsubscribe?token=signed",
    });

    expect(email.html).toContain("Launch notes");
    expect(email.html).toContain("https://cdn.example.com/studio-notes.png");
    expect(email.html).toContain("A week inside the studio");
    expect(email.html).not.toContain("https://bento.surf/branding/bento-logo.png");
    expect(email.html).toContain("The full structured issue.");
    expect(email.text).toContain("Launch notes\n\nThe full structured issue.");
    expect(email.html).toContain("Unsubscribe");
    expect(email.html).toContain("#b45309");
    expect(email.html).toContain(
      "&lt;script&gt;alert(&quot;postal&quot;)&lt;/script&gt; 123 Studio Road",
    );
    expect(email.html).not.toContain('<script>alert("postal")</script>');
    expect(email.text).toContain('<script>alert("postal")</script> 123 Studio Road');
  });

  it("renders a same-origin newsletter confirmation without trusting payload HTML", async () => {
    process.env.EMAIL_SIGNING_SECRET = "test-email-signing-secret-with-more-than-32-characters";
    const input = {
      publicationId: "11111111-1111-4111-8111-111111111111",
      subscriptionId: "22222222-2222-4222-8222-222222222222",
      confirmationNonce: "33333333-3333-4333-8333-333333333333",
      email: "Reader@Example.com",
    };
    const token = await createNewsletterConfirmationToken(input);
    await expect(verifyNewsletterConfirmationToken(token)).resolves.toEqual({
      publicationId: input.publicationId,
      subscriptionId: input.subscriptionId,
      confirmationNonce: input.confirmationNonce,
      email: "reader@example.com",
    });

    const email = renderBentoEmail({
      eventType: "newsletter_subscription_confirmation",
      category: "transactional",
      payload: {
        publicationTitle: '<img src=x onerror="alert(1)">',
        confirmationUrl: `https://evil.example/confirm?token=${token}`,
      },
      appUrl: "https://app.bento.surf",
    });
    expect(email.html).toContain("https://app.bento.surf/");
    expect(email.html).not.toContain("evil.example");
    expect(email.html).not.toContain("<img src=x");
    expect(email.html).not.toContain('onerror="');
  });
  it("signs newsletter confirmation URLs only when the durable email is delivered", async () => {
    process.env.EMAIL_SIGNING_SECRET = "test-email-signing-secret-with-more-than-32-characters";
    process.env.VITE_APP_URL = "https://app.test.bento.surf";
    const payload = await prepareEmailPayloadForDelivery({
      eventType: "newsletter_subscription_confirmation",
      recipientEmail: "reader@example.com",
      payload: {
        publicationId: "11111111-1111-4111-8111-111111111111",
        subscriptionId: "22222222-2222-4222-8222-222222222222",
        confirmationNonce: "33333333-3333-4333-8333-333333333333",
        email: "reader@example.com",
        publicationTitle: "Studio Notes",
        creatorUsername: "ari",
      },
    });
    const url = new URL(String(payload.confirmationUrl));
    expect(url.origin).toBe("https://app.test.bento.surf");
    const token = url.searchParams.get("confirm") || "";
    await expect(verifyNewsletterConfirmationToken(token)).resolves.toMatchObject({
      confirmationNonce: "33333333-3333-4333-8333-333333333333",
    });
  });
  it("normalizes valid recipients and rejects values the outbox cannot store", () => {
    expect(normalizeEmailRecipient(" Creator@Example.com ")).toBe("creator@example.com");
    expect(normalizeEmailRecipient("not-an-email")).toBeNull();
    expect(normalizeEmailRecipient(`creator@${"a".repeat(250)}.com`)).toBeNull();
  });

  it("renders branded HTML and plain text with a single primary action", () => {
    const email = renderBentoEmail({
      eventType: "buyer_receipt",
      category: "transactional",
      recipientName: "Maya",
      payload: {
        productTitle: "Creator OS",
        creatorName: "Ari",
        amount: 2900,
        currency: "usd",
        accessUrl: "https://bento.surf/access/private-token",
      },
      appUrl: "https://bento.surf",
    });

    expect(email.subject).toContain("Creator OS");
    expect(email.html).toContain("bento.surf");
    expect(email.html).toContain("https://bento.surf/branding/bento-logo.png");
    expect(email.html).toContain("Instrument Serif");
    expect(email.html).toContain("font-family:Inter");
    expect(email.html).toContain("$29.00");
    expect(email.html).toContain("https://bento.surf/access/private-token");
    expect(email.text).toContain("Open my purchase");
    expect(email.html).not.toContain("Unsubscribe");
  });

  it("links buyer messages to the creator conversation", () => {
    const accessUrl =
      "https://app.bento.surf/priority-dm?thread=11111111-1111-4111-8111-111111111111";
    const received = renderBentoEmail({
      eventType: "priority_dm_received",
      category: "transactional",
      recipientName: "Ari",
      payload: {
        productTitle: "Priority DM",
        buyerName: "Maya",
        amount: 2500,
        currency: "usd",
        message: "Can you review my launch page?",
        accessUrl,
      },
      appUrl: "https://app.bento.surf",
    });
    expect(received.subject).toContain("priority message");
    expect(received.text).toContain("Can you review my launch page?");
    expect(received.text).toContain("Open priority inbox");
    expect(received.html).toContain(accessUrl.replace(/&/g, "&amp;"));
  });

  it("links creator messages through a customer magic link with a safe return path", () => {
    const accessUrl =
      "https://app.bento.surf/library/verify?token=single-use-token&returnTo=%2Flibrary%2Fpriority-dm%2F11111111-1111-4111-8111-111111111111";
    const reply = renderBentoEmail({
      eventType: "priority_dm_reply",
      category: "transactional",
      recipientName: "Maya",
      payload: {
        creatorName: "Ari",
        productTitle: "Priority DM",
        reply: "Yes, send me the draft.",
        accessUrl,
      },
      appUrl: "https://app.bento.surf",
    });
    expect(reply.subject).toContain("Ari replied");
    expect(reply.text).toContain("Yes, send me the draft.");
    expect(reply.html).toContain(accessUrl.replace(/&/g, "&amp;"));
  });

  it("renders coaching reminders with the scheduled time and trusted Meet link", () => {
    const email = renderBentoEmail({
      eventType: "booking_reminder",
      category: "transactional",
      recipientName: "Maya",
      payload: {
        productTitle: "Portfolio review",
        reminderLabel: "Starts in 1 hour",
        startsIn: "in 1 hour",
        bookingDate: "Thursday, July 30 at 4:00 PM",
        meetingUrl: "https://meet.google.com/abc-defg-hij",
      },
      appUrl: "https://app.bento.surf",
    });
    expect(email.subject).toContain("Starts in 1 hour");
    expect(email.html).toContain("Thursday, July 30 at 4:00 PM");
    expect(email.html).toContain("https://meet.google.com/abc-defg-hij");
  });

  it("keeps production-quality subjects in sandbox while routing to the test inbox", () => {
    const delivery = resolveEmailDeliveryEnvelope({
      mode: "sandbox",
      originalRecipient: "creator@example.com",
      testRecipient: "qa@bento.surf",
      subject: "Your Bento is ready",
    });

    expect(delivery.recipient).toBe("qa@bento.surf");
    expect(delivery.subject).toBe("Your Bento is ready");
    expect(delivery.subject).not.toContain("STAGING");
    expect(delivery.diagnosticHeaders).toEqual({
      "X-Bento-Environment": "staging",
      "X-Bento-Original-Recipient": "creator@example.com",
    });
  });

  it("escapes recipient-controlled content and refuses off-site CTA URLs", () => {
    const email = renderBentoEmail({
      eventType: "buyer_receipt",
      category: "transactional",
      recipientName: "<img src=x onerror=alert(1)>",
      payload: {
        productTitle: "<script>alert(1)</script>",
        accessUrl: "https://evil.example/steal",
      },
      appUrl: "https://bento.surf",
    });

    expect(email.html).not.toContain("<script>");
    expect(email.html).not.toContain("onerror=");
    expect(email.html).not.toContain("evil.example");
  });

  it("adds an unsubscribe link only to consent-based marketing messages", () => {
    const email = renderBentoEmail({
      eventType: "weekly_digest",
      category: "marketing",
      payload: { views: 120, clicks: 18, sales: 2 },
      appUrl: "https://bento.surf",
      unsubscribeUrl: "https://bento.surf/api/email/unsubscribe?token=signed",
    });

    expect(email.subject).toContain("120 visits");
    expect(email.html).toContain("Unsubscribe");
    expect(email.text).toContain("unsubscribe?token=signed");
  });

  it("renders creator campaigns safely with the creator page as the only CTA", () => {
    const email = renderBentoEmail({
      eventType: "creator_campaign",
      category: "marketing",
      payload: {
        creatorName: "Ari",
        creatorUrl: "https://public.example/@ari",
        subject: "A new <chapter>",
        body: "The <script>alert('nope')</script> launch is live.",
      },
      appUrl: "https://app.example",
      publicUrl: "https://public.example",
      unsubscribeUrl: "https://app.example/api/email/unsubscribe?token=signed",
    });

    expect(email.subject).toBe("A new <chapter>");
    expect(email.html).toContain("https://public.example/@ari");
    expect(email.html).not.toContain("<script>");
    expect(email.html).toContain("&lt;script&gt;");
    expect(email.html).toContain("Unsubscribe");
  });

  it("renders a private community invitation without exposing its access token elsewhere", () => {
    const accessUrl = "https://bento.surf/access/private-community-token";
    const email = renderBentoEmail({
      eventType: "community_invite",
      category: "transactional",
      recipientName: "Maya",
      payload: {
        productTitle: "Creator Circle",
        creatorName: "Ari",
        accessUrl,
      },
      appUrl: "https://bento.surf",
    });

    expect(email.subject).toContain("Creator Circle");
    expect(email.html).toContain("Ari");
    expect(email.html).toContain(accessUrl);
    expect(email.text).toContain("Open the community");
    expect(email.html).not.toContain("Unsubscribe");
  });

  it("renders a private community update notification", () => {
    const email = renderBentoEmail({
      eventType: "community_update",
      category: "transactional",
      recipientName: "Maya",
      payload: {
        productTitle: "Creator Circle",
        creatorName: "Ari",
        preview: "The July resources are ready.",
        accessUrl: "https://app.bento.surf/library",
      },
      appUrl: "https://app.bento.surf",
    });

    expect(email.subject).toContain("Creator Circle");
    expect(email.html).toContain("The July resources are ready.");
    expect(email.text).toContain("Open my community");
  });

  it("renders the passwordless customer-library link as a transactional email", () => {
    const accessUrl = "https://app.bento.surf/library/verify?token=single-use-token";
    const email = renderBentoEmail({
      eventType: "customer_library_login",
      category: "transactional",
      recipientName: "Maya",
      payload: { accessUrl, expiresInMinutes: 15 },
      appUrl: "https://app.bento.surf",
    });

    expect(email.subject).toBe("Sign in to your Bento library");
    expect(email.html).toContain(accessUrl.replace(/&/g, "&amp;"));
    expect(email.text).toContain("15 minutes");
    expect(email.html).not.toContain("Unsubscribe");
  });

  it("renders a safe booking cancellation and rebooking link", () => {
    const accessUrl = "https://app.bento.surf/access/private-booking-token";
    const email = renderBentoEmail({
      eventType: "booking_canceled",
      category: "transactional",
      recipientName: "Maya",
      payload: {
        productTitle: "Creator coaching",
        creatorName: "Ari",
        buyerName: "Maya",
        bookingDate: "Thursday, 30 July at 10:00 am",
        accessUrl,
      },
      appUrl: "https://app.bento.surf",
    });

    expect(email.subject).toContain("Creator coaching");
    expect(email.text).toContain("Choose another time");
    expect(email.html).toContain(accessUrl);
  });
});

describe("email preference tokens", () => {
  const originalSecret = process.env.EMAIL_SIGNING_SECRET;

  afterEach(() => {
    process.env.EMAIL_SIGNING_SECRET = originalSecret;
  });

  it("round-trips signed preference data and rejects tampering", async () => {
    process.env.EMAIL_SIGNING_SECRET = "test-email-signing-secret-with-more-than-32-characters";
    const input = {
      userId: "9bf8b0a5-e1b1-4a34-8d42-75890048990f",
      email: "Creator@Example.com",
    };
    const token = await createEmailPreferenceToken(input);

    await expect(verifyEmailPreferenceToken(token)).resolves.toEqual({
      kind: "account",
      userId: input.userId,
      email: "creator@example.com",
    });
    await expect(verifyEmailPreferenceToken(`${token.slice(0, -1)}x`)).resolves.toBeNull();
  });

  it("round-trips creator audience unsubscribe data without exposing database access", async () => {
    process.env.EMAIL_SIGNING_SECRET = "test-email-signing-secret-with-more-than-32-characters";
    const input = {
      creatorId: "553a3c9f-6c0a-4b13-a932-1797ab0232f5",
      contactId: "f7294cf9-0717-4200-baca-8dc291914b64",
      email: "Buyer@Example.com",
    };
    const token = await createAudienceUnsubscribeToken(input);

    await expect(verifyEmailPreferenceToken(token)).resolves.toEqual({
      kind: "audience",
      creatorId: input.creatorId,
      contactId: input.contactId,
      email: "buyer@example.com",
    });
  });

  it("round-trips publication-scoped newsletter unsubscribe data", async () => {
    process.env.EMAIL_SIGNING_SECRET = "test-email-signing-secret-with-more-than-32-characters";
    const input = {
      publicationId: "11111111-1111-4111-8111-111111111111",
      subscriptionId: "22222222-2222-4222-8222-222222222222",
      email: "Reader@Example.com",
    };
    const token = await createNewsletterUnsubscribeToken(input);

    await expect(verifyEmailPreferenceToken(token)).resolves.toEqual({
      kind: "newsletter",
      publicationId: input.publicationId,
      subscriptionId: input.subscriptionId,
      email: "reader@example.com",
    });
  });

  it("requires an explicit POST before changing unsubscribe preferences", async () => {
    process.env.EMAIL_SIGNING_SECRET = "test-email-signing-secret-with-more-than-32-characters";
    const token = await createEmailPreferenceToken({
      userId: "9bf8b0a5-e1b1-4a34-8d42-75890048990f",
      email: "creator@example.com",
    });
    const response = await handleEmailUnsubscribeRequest(
      new Request(`https://bento.surf/api/email/unsubscribe?token=${encodeURIComponent(token)}`),
    );

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toContain('method="post"');
  });
});
