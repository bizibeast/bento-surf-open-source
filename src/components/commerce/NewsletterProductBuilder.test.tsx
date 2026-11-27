import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createNewsletterPublication,
  getMyNewsletterPublication,
  savePaidNewsletterOffer,
  updateNewsletterPublication,
} from "@/lib/newsletter.functions";
import { NewsletterProductBuilder } from "./NewsletterProductBuilder";

vi.mock("@/lib/newsletter.functions", () => ({
  createNewsletterPublication: vi.fn(),
  getMyNewsletterPublication: vi.fn(),
  savePaidNewsletterOffer: vi.fn(),
  updateNewsletterPublication: vi.fn(),
  setDefaultNewsletterPublication: vi.fn(),
  archiveNewsletterPublication: vi.fn(),
}));
vi.mock("@/components/blocks/FileDropzone", () => ({
  FileDropzone: ({ label }: { label?: string }) => <div>{label}</div>,
}));
const publicationId = "11111111-1111-4111-8111-111111111111";
const publication = {
  id: publicationId,
  title: "Studio Notes",
  description: "Dispatches from the studio",
  slug: "studio-notes",
  sender_name: "Ari",
  reply_to_email: "ari@example.com",
  postal_address: "123 Studio Road",
  accent_color: "#3478f6",
  logo_url: "https://example.com/logo.png",
  status: "draft",
  default_template_id: "editorial" as const,
  is_default: true,
};
function mount(props: Partial<Parameters<typeof NewsletterProductBuilder>[0]> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onOpenChange = vi.fn();
  const onSaved = vi.fn();
  render(
    <QueryClientProvider client={client}>
      <NewsletterProductBuilder open onOpenChange={onOpenChange} onSaved={onSaved} {...props} />
    </QueryClientProvider>,
  );
  return { onOpenChange, onSaved, client };
}
function fillCreateForm() {
  fireEvent.change(screen.getByLabelText("Publication name"), {
    target: { value: "Studio Notes" },
  });
  fireEvent.change(screen.getByLabelText("Description"), {
    target: { value: "Dispatches from the studio" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  fireEvent.change(screen.getByLabelText("Sender name"), { target: { value: "Ari" } });
  fireEvent.change(screen.getByLabelText("Reply-to email"), {
    target: { value: "ari@example.com" },
  });
  fireEvent.change(screen.getByLabelText("Postal address"), {
    target: { value: "123 Studio Road" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(createNewsletterPublication).mockResolvedValue({ id: publicationId });
  vi.mocked(getMyNewsletterPublication).mockResolvedValue({
    publication,
    creatorUsername: "ari",
    products: [],
    posts: [],
    websiteArchive: null,
  });
  vi.mocked(updateNewsletterPublication).mockResolvedValue(publication);
});

describe("NewsletterProductBuilder canonical publication lifecycle", () => {
  it("retains unsaved publication edits when a cached publication refresh fails", async () => {
    const { client } = mount({ publicationId });
    const title = await screen.findByLabelText("Publication name");
    fireEvent.change(title, { target: { value: "Keep my unsaved publication name" } });
    vi.mocked(getMyNewsletterPublication).mockRejectedValueOnce(new Error("Refresh failed"));
    await act(async () => {
      await client.refetchQueries({ queryKey: ["newsletter-publication", publicationId] });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(client.getQueryState(["newsletter-publication", publicationId])).toMatchObject({
      status: "error",
      fetchStatus: "idle",
    });
    expect(screen.getByLabelText("Publication name")).toHaveValue(
      "Keep my unsaved publication name",
    );
  });
  it("creates a draft through the publication API without a generic product or publish side effect", async () => {
    const callbacks = mount();
    fillCreateForm();
    fireEvent.click(screen.getByRole("button", { name: "Create publication" }));
    await waitFor(() => expect(callbacks.onSaved).toHaveBeenCalledWith(publicationId));
    expect(createNewsletterPublication).toHaveBeenCalledExactlyOnceWith({
      data: {
        title: "Studio Notes",
        description: "Dispatches from the studio",
        senderName: "Ari",
        replyToEmail: "ari@example.com",
        postalAddress: "123 Studio Road",
        logoUrl: null,
        defaultTemplateId: "editorial",
        status: "draft",
      },
    });
    expect(savePaidNewsletterOffer).not.toHaveBeenCalled();
    expect(callbacks.onOpenChange).toHaveBeenCalledWith(false);
  });
  it("retains unsaved publication details when creation fails", async () => {
    vi.mocked(createNewsletterPublication).mockRejectedValueOnce(
      new Error("Plan upgrade required"),
    );
    const callbacks = mount();
    fillCreateForm();
    fireEvent.click(screen.getByRole("button", { name: "Create publication" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Plan upgrade required");
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByLabelText("Publication name")).toHaveValue("Studio Notes");
    expect(callbacks.onOpenChange).not.toHaveBeenCalled();
  });
  it("does not duplicate a created draft when refreshing the caller fails and the creator retries", async () => {
    const onSaved = vi
      .fn()
      .mockRejectedValueOnce(new Error("Could not refresh products"))
      .mockResolvedValue(undefined);
    mount({ onSaved });
    fillCreateForm();
    fireEvent.click(screen.getByRole("button", { name: "Create publication" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not refresh products");
    fireEvent.click(screen.getByRole("button", { name: "Create publication" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(2));
    expect(createNewsletterPublication).toHaveBeenCalledTimes(1);
    expect(updateNewsletterPublication).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ publicationId, status: "draft" }),
      }),
    );
  });
  it("edits an existing publication in place while preserving email identity, template, branding and draft status", async () => {
    mount({ publicationId });
    await screen.findByRole("heading", { name: "General" });
    fireEvent.change(screen.getByLabelText("Publication name"), {
      target: { value: "Studio Letters" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    await waitFor(() =>
      expect(updateNewsletterPublication).toHaveBeenCalledWith({
        data: {
          publicationId,
          title: "Studio Letters",
          description: publication.description,
          senderName: publication.sender_name,
          replyToEmail: publication.reply_to_email,
          postalAddress: publication.postal_address,
          accentColor: publication.accent_color,
          logoUrl: publication.logo_url,
          defaultTemplateId: "editorial",
          status: "draft",
        },
      }),
    );
    expect(createNewsletterPublication).not.toHaveBeenCalled();
  });
  it("keeps the publication and paid form intact when the canonical paid-newsletter eligibility check rejects the provider", async () => {
    vi.mocked(savePaidNewsletterOffer).mockRejectedValueOnce(
      new Error("Paid newsletters currently require Stripe."),
    );
    const callbacks = mount({ publicationId });
    await screen.findByRole("heading", { name: "General" });
    fireEvent.click(screen.getByRole("button", { name: "Subscription & payment" }));
    fireEvent.change(screen.getByLabelText("Price"), { target: { value: "9" } });
    fireEvent.click(screen.getByRole("button", { name: "Save paid access" }));
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Paid newsletters currently require Stripe.",
    );
    expect(savePaidNewsletterOffer).toHaveBeenCalledWith({
      data: { publicationId, priceAmount: 900, currency: "usd", billingInterval: "month" },
    });
    expect(callbacks.onOpenChange).not.toHaveBeenCalled();
    expect(createNewsletterPublication).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Price")).toHaveValue(9);
  });
});
