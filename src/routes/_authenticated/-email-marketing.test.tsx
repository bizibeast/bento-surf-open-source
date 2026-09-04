import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentType, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getMyEmailMarketing,
  getPublicationRecipientCounts,
} from "@/lib/commerce-growth.functions";
import {
  getMyNewsletterPublication,
  getMyNewsletterPublications,
} from "@/lib/newsletter.functions";

const routeState = vi.hoisted(() => ({
  publication: undefined as string | undefined,
  section: "overview" as
    | "overview"
    | "write"
    | "posts"
    | "broadcasts"
    | "templates"
    | "subscribers"
    | "website"
    | "settings",
  post: undefined as string | undefined,
  intent: undefined as "schedule" | undefined,
  settings: undefined as
    "details" | "seo" | "branding" | "template" | "email" | "paid" | "advanced" | undefined,
}));
const navigate = vi.hoisted(() => vi.fn());

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: Record<string, unknown>) => ({
    ...options,
    options,
    useSearch: () => routeState,
  }),
  Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
  useNavigate: () => navigate,
}));

vi.mock("@/lib/commerce-growth.functions", () => ({
  getMyEmailMarketing: vi.fn(),
  getPublicationRecipientCounts: vi.fn().mockResolvedValue({ all: 0 }),
  createAudienceList: vi.fn(),
  deleteAudienceList: vi.fn(),
  setAudienceListMember: vi.fn(),
  saveAudienceCampaign: vi.fn(),
  deleteAudienceCampaign: vi.fn(),
  sendAudienceCampaign: vi.fn(),
}));
vi.mock("@/lib/newsletter.functions", () => ({
  getMyNewsletterPublication: vi.fn(),
  getMyNewsletterPublications: vi.fn(),
  createNewsletterPublication: vi.fn(),
  addNewsletterToBento: vi.fn(),
  saveNewsletterPublication: vi.fn(),
  saveNewsletterIssue: vi.fn(),
  savePaidNewsletterOffer: vi.fn(),
  setDefaultNewsletterPublication: vi.fn(),
  archiveNewsletterPublication: vi.fn(),
  updateNewsletterPublication: vi.fn(),
  deleteNewsletterDraft: vi.fn(),
}));

import { Route } from "./email-marketing";

describe("Email Marketing workspace", () => {
  beforeEach(() => {
    vi.spyOn(window, "scrollTo").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
    routeState.publication = undefined;
    routeState.section = "overview";
    routeState.post = undefined;
    routeState.intent = undefined;
    routeState.settings = undefined;
  });

  it("selects the default publication and preserves it when opening Posts", async () => {
    vi.mocked(getMyEmailMarketing).mockResolvedValue({
      locked: false,
      plan: "store",
      products: [],
      audienceContacts: [],
      audienceEvents: [],
      audienceLists: [],
      audienceListMembers: [],
      audienceCampaigns: [],
      newsletterSubscriptions: [],
      contactUsage: { plan: "store", limit: 500, subscribed: 21, remaining: 479, overLimit: false },
    });
    vi.mocked(getMyNewsletterPublications).mockResolvedValue([
      {
        id: "11111111-1111-4111-8111-111111111111",
        title: "Studio Notes",
        slug: "studio-notes",
        logoUrl: null,
        status: "published",
        isDefault: false,
        subscriberCount: 8,
      },
      {
        id: "22222222-2222-4222-8222-222222222222",
        title: "Tech & Trends Weekly",
        slug: "tech-trends-weekly",
        logoUrl: null,
        status: "published",
        isDefault: true,
        subscriberCount: 13,
      },
    ]);
    vi.mocked(getMyNewsletterPublication).mockResolvedValue({
      publication: {
        id: "22222222-2222-4222-8222-222222222222",
        title: "Tech & Trends Weekly",
        description: "Weekly notes",
        sender_name: "Ada",
        reply_to_email: null,
        postal_address: "Bengaluru, India",
        accent_color: null,
        status: "published",
        paidProduct: null,
      },
      posts: [
        {
          id: "44444444-4444-4444-8444-444444444444",
          publication_id: "22222222-2222-4222-8222-222222222222",
          list_id: null,
          name: "Published first",
          subject: "Already sent",
          preview_text: "Published first",
          public_slug: "published-first",
          web_visibility: "public",
          status: "published",
          delivery_status: "draft",
          content: [{ id: "published-body", type: "paragraph", text: "Published." }],
          updated_at: "2026-08-31T10:00:00.000Z",
        },
        {
          id: "33333333-3333-4333-8333-333333333333",
          publication_id: "22222222-2222-4222-8222-222222222222",
          list_id: null,
          name: "Product Launch",
          subject: "We are live",
          preview_text: "The first issue",
          public_slug: null,
          web_visibility: "private",
          status: "draft",
          content: [{ id: "body", type: "paragraph", text: "Launch." }],
          updated_at: "2026-09-01T10:00:00.000Z",
        },
      ],
      products: [],
      creatorUsername: "Ada",
    } as never);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const EmailMarketingPage = Route.options.component as ComponentType;

    render(
      <QueryClientProvider client={client}>
        <EmailMarketingPage />
      </QueryClientProvider>,
    );

    const heading = screen.getByRole("heading", { name: "Email Marketing" });
    expect(heading).toBeVisible();
    expect(
      await screen.findByRole("button", {
        name: "Select publication, Tech & Trends Weekly, 13 subscribers",
      }),
    ).toBeVisible();
    expect(heading.nextElementSibling).toHaveAttribute("aria-label", "Publication controls");
    expect(screen.getByRole("navigation", { name: "Publication destinations" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Overview" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.queryByRole("button", { name: "Write" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Posts" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Broadcasts" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Templates" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Audience" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Website" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Settings" })).toBeVisible();
    expect(document.body).not.toHaveTextContent(/issue/i);

    const scrollTo = vi.mocked(window.scrollTo);

    fireEvent.click(await screen.findByRole("button", { name: "Continue writing" }));
    expect(navigate).toHaveBeenCalledWith({
      to: "/email-marketing",
      search: {
        publication: "22222222-2222-4222-8222-222222222222",
        section: "write",
        post: "33333333-3333-4333-8333-333333333333",
      },
    });
    expect(scrollTo).toHaveBeenLastCalledWith({ left: 0, top: 0, behavior: "auto" });

    fireEvent.click(screen.getByRole("button", { name: "Posts" }));
    expect(navigate).toHaveBeenCalledWith({
      to: "/email-marketing",
      search: {
        publication: "22222222-2222-4222-8222-222222222222",
        section: "posts",
      },
    });

    await userEvent.click(
      screen.getByRole("button", {
        name: "Select publication, Tech & Trends Weekly, 13 subscribers",
      }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Open settings for Tech & Trends Weekly" }),
    );
    expect(navigate).toHaveBeenCalledWith({
      to: "/email-marketing",
      search: {
        publication: "22222222-2222-4222-8222-222222222222",
        section: "settings",
        settings: "details",
      },
    });
  });

  it("normalizes invalid sections and maps legacy tabs to canonical destinations", () => {
    const schema = Route.options.validateSearch as {
      parse: (value: unknown) => {
        publication?: string;
        post?: string;
        section: string;
        tab?: string;
        settings?: string;
      };
    };
    expect(
      schema.parse({
        publication: "11111111-1111-4111-8111-111111111111",
        section: "legacy",
      }),
    ).toEqual({
      publication: "11111111-1111-4111-8111-111111111111",
      section: "overview",
    });
    expect(schema.parse({ publication: "not-an-id", section: "posts" })).toEqual({
      publication: undefined,
      section: "posts",
    });
    expect(schema.parse({ tab: "broadcasts" })).toMatchObject({ section: "broadcasts" });
    expect(schema.parse({ tab: "audience" })).toMatchObject({ section: "subscribers" });
    expect(schema.parse({ tab: "newsletter" })).toMatchObject({ section: "overview" });
    expect(schema.parse({ section: "settings", settings: "template" })).toMatchObject({
      section: "settings",
      settings: "template",
    });
    expect(schema.parse({ section: "settings", settings: "unknown" })).toMatchObject({
      section: "settings",
      settings: undefined,
    });
    expect(schema.parse({ tab: "audience" })).not.toHaveProperty("tab");
  });

  it("renders dedicated publication-scoped Posts and Templates destinations", async () => {
    const user = userEvent.setup();
    const publicationId = "11111111-1111-4111-8111-111111111111";
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    client.setQueryData(
      ["newsletter-publications"],
      [
        {
          id: publicationId,
          title: "Studio Notes",
          slug: "studio-notes",
          logoUrl: null,
          status: "published",
          isDefault: true,
          subscriberCount: 2,
        },
      ],
    );
    client.setQueryData(["newsletter-publication", publicationId], {
      publication: {
        id: publicationId,
        slug: "studio-notes",
        title: "Studio Notes",
        description: "Notes from the studio",
        sender_name: "Ada",
        reply_to_email: null,
        postal_address: "Bengaluru, India",
        accent_color: "#3478f6",
        logo_url: null,
        default_template_id: "editorial",
        status: "published",
        paidProduct: null,
      },
      posts: [
        {
          id: "22222222-2222-4222-8222-222222222222",
          publication_id: publicationId,
          list_id: null,
          name: "September draft",
          subject: "September draft",
          preview_text: "Still writing",
          public_slug: "september-draft",
          web_visibility: "public",
          status: "draft",
          delivery_status: "draft",
          content: [{ id: "body", type: "paragraph", text: "Draft body" }],
        },
      ],
      products: [],
      creatorUsername: "ada",
    });
    client.setQueryData(["my-email-marketing"], {
      locked: false,
      contactUsage: { subscribed: 2, limit: 500 },
    });
    routeState.publication = publicationId;
    routeState.section = "posts";
    const EmailMarketingPage = Route.options.component as ComponentType;
    const view = render(
      <QueryClientProvider client={client}>
        <EmailMarketingPage />
      </QueryClientProvider>,
    );

    expect(screen.getByRole("table", { name: "Posts" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Actions for September draft" })).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Actions for September draft" }));
    await user.click(screen.getByRole("menuitem", { name: "Schedule" }));
    expect(navigate).toHaveBeenCalledWith({
      to: "/email-marketing",
      search: {
        publication: publicationId,
        section: "write",
        post: "22222222-2222-4222-8222-222222222222",
        intent: "schedule",
      },
    });

    routeState.section = "write";
    routeState.post = "22222222-2222-4222-8222-222222222222";
    routeState.intent = "schedule";
    view.rerender(
      <QueryClientProvider client={client}>
        <EmailMarketingPage />
      </QueryClientProvider>,
    );
    expect(screen.getByRole("button", { name: "Back to posts" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Publish" })).not.toBeInTheDocument();

    routeState.section = "templates";
    routeState.intent = undefined;
    view.rerender(
      <QueryClientProvider client={client}>
        <EmailMarketingPage />
      </QueryClientProvider>,
    );
    expect(screen.getByRole("heading", { name: "Post templates" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Preview Classic Editorial" }));
    expect(screen.getByTitle("Email desktop preview")).toBeVisible();
    expect(document.body).not.toHaveTextContent(/issue/i);
  });

  it("resets mutable workspace state when switching publications in Settings", async () => {
    const firstId = "11111111-1111-4111-8111-111111111111";
    const secondId = "22222222-2222-4222-8222-222222222222";
    const publications = [
      {
        id: firstId,
        title: "First Publication",
        slug: "first-publication",
        logoUrl: null,
        status: "published",
        isDefault: true,
        subscriberCount: 1,
      },
      {
        id: secondId,
        title: "Second Publication",
        slug: "second-publication",
        logoUrl: null,
        status: "published",
        isDefault: false,
        subscriberCount: 2,
      },
    ];
    const selected = (id: string, title: string) => ({
      publication: {
        id,
        title,
        description: `${title} description`,
        sender_name: title,
        reply_to_email: null,
        postal_address: "Bengaluru, India",
        accent_color: null,
        status: "published",
        paidProduct: null,
      },
      posts: [],
      products: [],
      creatorUsername: "Ada",
    });
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    client.setQueryData(["newsletter-publications"], publications);
    client.setQueryData(
      ["newsletter-publication", firstId],
      selected(firstId, "First Publication"),
    );
    client.setQueryData(
      ["newsletter-publication", secondId],
      selected(secondId, "Second Publication"),
    );
    client.setQueryData(["my-email-marketing"], {
      locked: false,
      plan: "store",
      products: [],
      audienceContacts: [],
      audienceEvents: [],
      audienceLists: [],
      audienceListMembers: [],
      audienceCampaigns: [],
      newsletterSubscriptions: [],
      contactUsage: { plan: "store", limit: 500, subscribed: 0, remaining: 500, overLimit: false },
    });
    routeState.publication = firstId;
    routeState.section = "settings";
    const EmailMarketingPage = Route.options.component as ComponentType;
    const view = render(
      <QueryClientProvider client={client}>
        <EmailMarketingPage />
      </QueryClientProvider>,
    );

    expect(screen.getByLabelText("Publication name")).toHaveValue("First Publication");
    fireEvent.change(screen.getByLabelText("Publication name"), {
      target: { value: "Unsaved first publication" },
    });

    routeState.publication = secondId;
    view.rerender(
      <QueryClientProvider client={client}>
        <EmailMarketingPage />
      </QueryClientProvider>,
    );
    expect(screen.getByLabelText("Publication name")).toHaveValue("Second Publication");
  });

  it("never requests recipient counts for a locked creator", async () => {
    const publicationId = "11111111-1111-4111-8111-111111111111";
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    client.setQueryData(
      ["newsletter-publications"],
      [
        {
          id: publicationId,
          title: "Studio Notes",
          slug: "studio-notes",
          logoUrl: null,
          status: "published",
          isDefault: true,
          subscriberCount: 0,
        },
      ],
    );
    client.setQueryData(["newsletter-publication", publicationId], {
      publication: {
        id: publicationId,
        title: "Studio Notes",
        description: "Weekly notes",
        sender_name: "Ada",
        reply_to_email: null,
        postal_address: "Bengaluru, India",
        accent_color: null,
        status: "published",
        paidProduct: null,
      },
      posts: [],
      products: [],
      creatorUsername: "Ada",
    });
    client.setQueryData(["my-email-marketing"], {
      locked: true,
      plan: "free",
      products: [],
      audienceContacts: [],
      audienceEvents: [],
      audienceLists: [],
      audienceListMembers: [],
      audienceCampaigns: [],
      newsletterSubscriptions: [],
      contactUsage: { plan: "free", limit: 0, subscribed: 0, remaining: 0, overLimit: false },
    });
    routeState.publication = publicationId;
    routeState.section = "broadcasts";
    const EmailMarketingPage = Route.options.component as ComponentType;

    render(
      <QueryClientProvider client={client}>
        <EmailMarketingPage />
      </QueryClientProvider>,
    );

    expect(await screen.findByText(/Email marketing is included with Store/i)).toBeVisible();
    expect(getPublicationRecipientCounts).not.toHaveBeenCalled();
  });

  it("routes Website controls to exact settings panels and keeps them synchronized", async () => {
    const publicationId = "11111111-1111-4111-8111-111111111111";
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    client.setQueryData(
      ["newsletter-publications"],
      [
        {
          id: publicationId,
          title: "Studio Notes",
          slug: "studio-notes",
          logoUrl: null,
          status: "published",
          isDefault: true,
          subscriberCount: 2,
        },
      ],
    );
    client.setQueryData(["newsletter-publication", publicationId], {
      publication: {
        id: publicationId,
        title: "Studio Notes",
        slug: "studio-notes",
        description: "Weekly notes",
        sender_name: "Ada",
        reply_to_email: null,
        postal_address: "Bengaluru, India",
        accent_color: null,
        status: "published",
        default_template_id: "editorial",
        paidProduct: null,
      },
      posts: [],
      products: [],
      creatorUsername: "Ada",
    });
    client.setQueryData(["my-email-marketing"], {
      locked: false,
      plan: "store",
      products: [],
      audienceContacts: [],
      audienceEvents: [],
      audienceLists: [],
      audienceListMembers: [],
      audienceCampaigns: [],
      newsletterSubscriptions: [],
      contactUsage: { plan: "store", limit: 500, subscribed: 2, remaining: 498, overLimit: false },
    });
    routeState.publication = publicationId;
    routeState.section = "website";
    const EmailMarketingPage = Route.options.component as ComponentType;
    const view = render(
      <QueryClientProvider client={client}>
        <EmailMarketingPage />
      </QueryClientProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "SEO" }));
    expect(navigate).toHaveBeenCalledWith({
      to: "/email-marketing",
      search: { publication: publicationId, section: "settings", settings: "seo" },
    });

    routeState.section = "settings";
    routeState.settings = "seo";
    view.rerender(
      <QueryClientProvider client={client}>
        <EmailMarketingPage />
      </QueryClientProvider>,
    );
    expect(screen.getByRole("heading", { name: "Website" })).toBeVisible();
    routeState.settings = "template";
    view.rerender(
      <QueryClientProvider client={client}>
        <EmailMarketingPage />
      </QueryClientProvider>,
    );
    expect(screen.getByRole("heading", { name: "General" })).toBeVisible();
  });
});
