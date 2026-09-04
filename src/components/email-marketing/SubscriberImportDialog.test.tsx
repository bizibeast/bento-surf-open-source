import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SubscriberImportDialog } from "./SubscriberImportDialog";

const mocks = vi.hoisted(() => ({
  importPublicationSubscribers: vi.fn(),
  previewPublicationSubscriberImport: vi.fn(),
}));

vi.mock("@/lib/newsletter-import.functions", () => mocks);

const publication = {
  id: "11111111-1111-4111-8111-111111111111",
  title: "Studio Notes",
};

function renderDialog() {
  const onImported = vi.fn().mockResolvedValue(undefined);
  const onOpenChange = vi.fn();
  render(
    <SubscriberImportDialog
      open
      onOpenChange={onOpenChange}
      publication={publication}
      onImported={onImported}
    />,
  );
  return { onImported, onOpenChange };
}

async function uploadCsv(text: string, name = "subscribers.csv") {
  const user = userEvent.setup();
  await user.upload(
    screen.getByLabelText("CSV file"),
    new File([text], name, { type: "text/csv" }),
  );
  return user;
}

async function mapColumns(user: ReturnType<typeof userEvent.setup>) {
  await screen.findByRole("heading", { name: "Map columns" });
  await user.selectOptions(screen.getByRole("combobox", { name: "Email column" }), "address");
  await user.selectOptions(screen.getByRole("combobox", { name: "Name column" }), "display name");
  await user.selectOptions(screen.getByRole("combobox", { name: "List column" }), "group");
  await user.click(screen.getByRole("button", { name: "Review import" }));
}

describe("SubscriberImportDialog", () => {
  afterEach(cleanup);

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.importPublicationSubscribers.mockReset().mockResolvedValue({
      imported: 1,
      updated: 0,
      skipped: 1,
      invalid: 1,
      blocked: 0,
    });
    mocks.previewPublicationSubscriberImport.mockReset().mockResolvedValue({
      existing: 0,
      required: 1,
      blocked: 0,
    });
  });

  it("maps CSV columns and reviews unique valid, duplicate, invalid, and capacity counts", async () => {
    renderDialog();
    const user = await uploadCsv(
      "Address,Display Name,Group\na@example.com,Ada,Founders\na@example.com,Ada Again,VIP\nnot-an-email,Bad,Founders",
    );

    expect(await screen.findByRole("heading", { name: "Map columns" })).toBeVisible();
    await mapColumns(user);

    expect(screen.getByRole("heading", { name: "Review import" })).toBeVisible();
    expect(screen.getByText("1 valid")).toBeVisible();
    expect(screen.getByText("1 duplicate")).toBeVisible();
    expect(screen.getByText("1 invalid")).toBeVisible();
    expect(await screen.findByText("1 slots required")).toBeVisible();
    expect(screen.getByText("0 blocked by capacity")).toBeVisible();
    expect(mocks.previewPublicationSubscriberImport).toHaveBeenCalledWith({
      data: {
        publicationId: publication.id,
        rows: expect.arrayContaining([{ email: "a@example.com", name: "Ada", list: "Founders" }]),
      },
    });
    expect(screen.getByRole("button", { name: "Import subscribers" })).toBeDisabled();
    await user.click(
      screen.getByRole("checkbox", { name: /I confirm these subscribers consented/i }),
    );
    expect(screen.getByRole("button", { name: "Import subscribers" })).toBeEnabled();
  });

  it("reuses one batch ID when a retry follows a retry-safe server error", async () => {
    mocks.importPublicationSubscribers
      .mockRejectedValueOnce(new Error("Temporary import failure. Retry with the same file."))
      .mockResolvedValueOnce({ imported: 1, updated: 1, skipped: 2, invalid: 3, blocked: 4 });
    const { onImported } = renderDialog();
    const user = await uploadCsv(
      "Address,Display Name,Group\na@example.com,Ada,Founders\nb@example.com,Ben,VIP",
    );
    await mapColumns(user);
    await user.click(
      screen.getByRole("checkbox", { name: /I confirm these subscribers consented/i }),
    );
    await user.click(screen.getByRole("button", { name: "Import subscribers" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Temporary import failure");
    expect(screen.getByText("2 valid")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Retry import" }));

    expect(await screen.findByRole("heading", { name: "Import complete" })).toBeVisible();
    expect(screen.getByText("1 imported")).toBeVisible();
    expect(screen.getByText("1 updated")).toBeVisible();
    expect(screen.getByText("2 skipped")).toBeVisible();
    expect(screen.getByText("3 invalid")).toBeVisible();
    expect(screen.getByText("4 blocked by capacity")).toBeVisible();
    expect(mocks.importPublicationSubscribers).toHaveBeenCalledTimes(2);
    const first = mocks.importPublicationSubscribers.mock.calls[0][0].data;
    const second = mocks.importPublicationSubscribers.mock.calls[1][0].data;
    expect(first.batchId).toMatch(/^[0-9a-f-]{36}$/);
    expect(second.batchId).toBe(first.batchId);
    expect(first).toMatchObject({
      publicationId: publication.id,
      consentConfirmed: true,
      rows: [
        { email: "a@example.com", name: "Ada", list: "Founders" },
        { email: "b@example.com", name: "Ben", list: "VIP" },
      ],
    });
    expect(onImported).toHaveBeenCalledTimes(1);
  });

  it("shows import progress while the single server mutation is pending", async () => {
    let resolveImport!: (value: unknown) => void;
    mocks.importPublicationSubscribers.mockReturnValue(
      new Promise((resolve) => {
        resolveImport = resolve;
      }),
    );
    renderDialog();
    const user = await uploadCsv("Address\na@example.com");
    await screen.findByRole("heading", { name: "Map columns" });
    await user.selectOptions(screen.getByRole("combobox", { name: "Email column" }), "address");
    await user.click(screen.getByRole("button", { name: "Review import" }));
    await user.click(
      screen.getByRole("checkbox", { name: /I confirm these subscribers consented/i }),
    );
    await user.click(screen.getByRole("button", { name: "Import subscribers" }));

    expect(screen.getByRole("progressbar", { name: "Import progress" })).toHaveAttribute(
      "aria-valuetext",
      "Importing subscribers",
    );
    expect(screen.getByRole("button", { name: "Importing…" })).toBeDisabled();
    resolveImport({ imported: 1, updated: 0, skipped: 0, invalid: 0, blocked: 0 });
    expect(await screen.findByRole("heading", { name: "Import complete" })).toBeVisible();
  });

  it("keeps malformed file errors visible and generates a new batch for a new upload", async () => {
    renderDialog();
    await uploadCsv('email\n"unterminated', "broken.csv");

    expect(await screen.findByRole("alert")).toHaveTextContent("CSV could not be parsed");
    expect(screen.queryByRole("button", { name: "Review import" })).not.toBeInTheDocument();

    const input = screen.getByLabelText("CSV file");
    fireEvent.change(input, {
      target: { files: [new File(["email\na@example.com"], "fixed.csv", { type: "text/csv" })] },
    });
    expect(await screen.findByRole("heading", { name: "Map columns" })).toBeVisible();
    await waitFor(() => expect(screen.getByText("fixed.csv")).toBeVisible());
  });

  it("ignores a late file read after a newer CSV is selected", async () => {
    const readers: Array<{
      result: string | null;
      onload: ((event: ProgressEvent<FileReader>) => void) | null;
    }> = [];
    class DeferredFileReader {
      result: string | null = null;
      error = null;
      onload: ((event: ProgressEvent<FileReader>) => void) | null = null;
      onerror = null;
      readAsText() {
        readers.push(this);
      }
    }
    vi.stubGlobal("FileReader", DeferredFileReader);
    renderDialog();
    const input = screen.getByLabelText("CSV file");
    fireEvent.change(input, { target: { files: [new File(["email\na@example.com"], "a.csv")] } });
    fireEvent.change(input, { target: { files: [new File(["address\nb@example.com"], "b.csv")] } });
    readers[1].result = "address\nb@example.com";
    readers[1].onload?.(new ProgressEvent("load") as ProgressEvent<FileReader>);
    expect(await screen.findByText("b.csv")).toBeVisible();
    readers[0].result = "email\na@example.com";
    readers[0].onload?.(new ProgressEvent("load") as ProgressEvent<FileReader>);
    expect(screen.getByText("b.csv")).toBeVisible();
    vi.unstubAllGlobals();
  });

  it("uses the Radix dialog primitive for Escape close and controlled state", async () => {
    const user = userEvent.setup();
    const { onOpenChange } = renderDialog();
    expect(screen.getByRole("dialog")).toHaveAttribute("data-state", "open");
    await user.keyboard("{Escape}");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
