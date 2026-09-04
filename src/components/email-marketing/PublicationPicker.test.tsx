import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createNewsletterPublication } from "@/lib/newsletter.functions";
import { PublicationPicker } from "./PublicationPicker";

vi.mock("@/lib/newsletter.functions", () => ({
  createNewsletterPublication: vi.fn(),
}));
vi.mock("@/components/blocks/FileDropzone", () => ({
  FileDropzone: ({ label }: { label?: string }) => <div>{label}</div>,
}));

const publications = [
  {
    id: "11111111-1111-4111-8111-111111111111",
    title: "Studio Notes",
    slug: "studio-notes",
    logoUrl: null,
    status: "published",
    isDefault: true,
    subscriberCount: 12,
  },
  {
    id: "22222222-2222-4222-8222-222222222222",
    title: "Tech & Trends Weekly",
    slug: "tech-trends-weekly",
    logoUrl: null,
    status: "draft",
    isDefault: false,
    subscriberCount: 3,
  },
];

afterEach(() => {
  vi.clearAllMocks();
});

describe("PublicationPicker", () => {
  it("opens the complete publication setup automatically for a first-time creator", () => {
    render(
      <PublicationPicker
        publications={[]}
        selectedPublicationId={null}
        onSelectPublication={vi.fn()}
        onPublicationCreated={vi.fn()}
      />,
    );

    expect(screen.getByRole("dialog", { name: "Set up your publication" })).toBeVisible();
    expect(screen.getByLabelText("Publication setup steps")).toBeVisible();
    expect(screen.getByLabelText("Publication name")).toBeVisible();
  });

  it("keeps publication creation and settings inside the compact picker", async () => {
    const user = userEvent.setup();
    const onOpenSettings = vi.fn();
    render(
      <PublicationPicker
        publications={publications}
        selectedPublicationId={publications[0].id}
        onSelectPublication={vi.fn()}
        onPublicationCreated={vi.fn()}
        onOpenSettings={onOpenSettings}
      />,
    );

    expect(screen.queryByRole("button", { name: "Add publication" })).not.toBeInTheDocument();
    const trigger = screen.getByRole("button", {
      name: "Select publication, Studio Notes, 12 subscribers",
    });
    expect(trigger).toHaveClass("h-auto", "min-h-9", "[padding:0.35rem_0.625rem]");
    expect(trigger.className).not.toContain("px-");
    await user.click(trigger);
    await user.click(screen.getByRole("button", { name: "Open settings for Studio Notes" }));
    expect(onOpenSettings).toHaveBeenCalledOnce();
  });

  it("switches between named publications with subscriber context", async () => {
    const user = userEvent.setup();
    const onSelectPublication = vi.fn();
    render(
      <PublicationPicker
        publications={publications}
        selectedPublicationId={publications[0].id}
        onSelectPublication={onSelectPublication}
        onPublicationCreated={vi.fn()}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: "Select publication, Studio Notes, 12 subscribers" }),
    );

    expect(screen.getByRole("menuitem", { name: "Studio Notes, 12 subscribers" })).toBeVisible();
    expect(
      screen.getByRole("menuitem", { name: "Tech & Trends Weekly, 3 subscribers" }),
    ).toBeVisible();
    await user.click(screen.getByRole("menuitem", { name: "Tech & Trends Weekly, 3 subscribers" }));
    expect(onSelectPublication).toHaveBeenCalledWith(publications[1].id);
  });

  it("keeps publication details and a server error in the dialog after creation fails", async () => {
    const user = userEvent.setup();
    vi.mocked(createNewsletterPublication).mockRejectedValue(
      new Error("A publication with this name already exists."),
    );
    render(
      <PublicationPicker
        publications={publications}
        selectedPublicationId={publications[0].id}
        onSelectPublication={vi.fn()}
        onPublicationCreated={vi.fn()}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: "Select publication, Studio Notes, 12 subscribers" }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Add publication" }));
    fireEvent.change(screen.getByLabelText("Publication name"), {
      target: { value: "Studio Notes" },
    });
    fireEvent.change(screen.getByLabelText("Description"), {
      target: { value: "Dispatches from the studio" },
    });
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByText("Upload a square (1:1) image for the best result.")).toBeVisible();
    fireEvent.change(screen.getByLabelText("Sender name"), { target: { value: "Ada" } });
    fireEvent.change(screen.getByLabelText("Reply-to email"), {
      target: { value: "hello@example.com" },
    });
    fireEvent.change(screen.getByLabelText("Postal address"), {
      target: { value: "Bengaluru, India" },
    });
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.click(screen.getByRole("button", { name: "Create publication" }));

    expect(
      await screen.findByRole("alert", { name: "Publication creation error" }),
    ).toHaveTextContent("A publication with this name already exists.");
    await user.click(screen.getByRole("button", { name: "Back" }));
    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByLabelText("Publication name")).toHaveValue("Studio Notes");
    expect(screen.getByRole("dialog")).toBeVisible();
  });

  it("closes only after a publication is successfully created", async () => {
    const user = userEvent.setup();
    let resolveCreation!: (value: { id: string }) => void;
    vi.mocked(createNewsletterPublication).mockReturnValue(
      new Promise((resolve) => {
        resolveCreation = resolve;
      }) as never,
    );
    const onPublicationCreated = vi.fn();
    render(
      <PublicationPicker
        publications={publications}
        selectedPublicationId={publications[0].id}
        onSelectPublication={vi.fn()}
        onPublicationCreated={onPublicationCreated}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: "Select publication, Studio Notes, 12 subscribers" }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Add publication" }));
    fireEvent.change(screen.getByLabelText("Publication name"), {
      target: { value: "Product Letters" },
    });
    fireEvent.change(screen.getByLabelText("Description"), {
      target: { value: "Product updates" },
    });
    await user.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.change(screen.getByLabelText("Sender name"), { target: { value: "Ada" } });
    fireEvent.change(screen.getByLabelText("Postal address"), {
      target: { value: "Bengaluru, India" },
    });
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.click(screen.getByRole("button", { name: "Create publication" }));

    expect(screen.getByRole("dialog")).toBeVisible();
    expect(screen.getByRole("button", { name: "Creating publication…" })).toBeDisabled();

    resolveCreation({ id: "33333333-3333-4333-8333-333333333333" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(onPublicationCreated).toHaveBeenCalledWith("33333333-3333-4333-8333-333333333333");
  });
});
