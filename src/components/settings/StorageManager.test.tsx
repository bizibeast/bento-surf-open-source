import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { StorageManager } from "./StorageManager";

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    auth: {
      getSession: vi.fn(async () => ({
        data: { session: { access_token: "token" } },
        error: null,
      })),
    },
  },
}));

const firstPage = {
  objects: [
    {
      key: "users/11111111-1111-4111-8111-111111111111/image/object.jpg",
      name: "Campaign image.jpg",
      type: "image",
      size: 1_024,
      uploaded: "2026-08-31T10:00:00.000Z",
      publicUrl: "https://bento.surf/cdn/users/example/image/object.jpg",
    },
  ],
  usedBytes: 3_072,
  allowedBytes: 10_240,
  cursor: "private:next",
};

function renderManager() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <StorageManager />
    </QueryClientProvider>,
  );
}

describe("StorageManager", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("renders usage and file details and pages with the returned cursor", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      return Response.json(
        url.includes("cursor=")
          ? {
              ...firstPage,
              objects: [
                {
                  ...firstPage.objects[0],
                  key: "private/users/11111111-1111-4111-8111-111111111111/store/guide.pdf",
                  name: "Guide.pdf",
                  type: "product_file",
                  size: 2_048,
                  uploaded: "2026-09-01T10:00:00.000Z",
                  publicUrl: null,
                },
              ],
              cursor: null,
            }
          : firstPage,
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    renderManager();

    expect(await screen.findByText("Campaign image.jpg")).toBeVisible();
    expect(screen.getByText("3 KB used of 10 KB")).toBeVisible();
    expect(screen.getByText("7 KB remaining")).toBeVisible();
    expect(screen.getByText("image")).toBeVisible();
    expect(screen.getByText("Aug 31, 2026")).toBeVisible();
    expect(screen.getByText("1 KB")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    expect(await screen.findByText("Guide.pdf")).toBeVisible();
    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/storage/manage?cursor=private%3Anext",
      expect.objectContaining({ headers: { Authorization: "Bearer token" } }),
    );
    expect(screen.getByRole("button", { name: "Previous page" })).toBeEnabled();
  });

  it("confirms destructive deletion, refreshes, and exposes partial failures", async () => {
    const failedKey = "private/users/11111111-1111-4111-8111-111111111111/store/guide.pdf";
    let getCount = 0;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "DELETE") {
        return Response.json(
          {
            deletedKeys: firstPage.objects.map((object) => object.key),
            failedKeys: [failedKey],
            freedBytes: 1_024,
          },
          { status: 207 },
        );
      }
      getCount += 1;
      return Response.json(firstPage);
    });
    vi.stubGlobal("fetch", fetchMock);
    renderManager();

    fireEvent.click(await screen.findByRole("checkbox", { name: "Select Campaign image.jpg" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete 1 file" }));
    expect(screen.getByRole("dialog")).toHaveTextContent("Delete 1 file?");
    expect(screen.getByRole("dialog")).toHaveTextContent(
      "Files disappear everywhere they are currently used.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Delete permanently" }));

    await waitFor(() => expect(getCount).toBe(2));
    expect(await screen.findByRole("alert")).toHaveTextContent("1 file could not be deleted");
    const deleteCall = fetchMock.mock.calls.find(([, init]) => init?.method === "DELETE");
    expect(JSON.parse(String(deleteCall?.[1]?.body))).toEqual({
      keys: firstPage.objects.map((object) => object.key),
    });
  });
});
