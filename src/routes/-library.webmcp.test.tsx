import { cleanup, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import type { WebMcpTool } from "@/lib/webmcp";

const mocks = vi.hoisted(() => ({
  createAccess: vi.fn(),
  logout: vi.fn(),
}));

vi.mock("@/lib/customer-library.functions", () => ({
  createCustomerLibraryAccess: mocks.createAccess,
  getCustomerLibrary: vi.fn(),
  logoutCustomerLibrary: mocks.logout,
  requestCustomerLibraryLink: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { LibraryHome } from "./library.index";

const GRANT_ID = "11111111-1111-4111-8111-111111111111";
let registerTool: ReturnType<typeof vi.fn>;

function Wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>;
}

function registeredTool(name: string) {
  const found = registerTool.mock.calls
    .map(([candidate]) => candidate as WebMcpTool)
    .find((candidate) => candidate.name === name);
  if (!found) throw new Error(`Missing WebMCP tool ${name}`);
  return found;
}

beforeEach(() => {
  vi.clearAllMocks();
  registerTool = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(document, "modelContext", {
    configurable: true,
    value: { registerTool },
  });
  vi.spyOn(window, "confirm").mockReturnValue(true);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete (document as Document & { modelContext?: unknown }).modelContext;
});

describe("customer library WebMCP cancellation", () => {
  it("does not confirm, dispatch, or navigate pre-canceled library actions", async () => {
    render(
      <LibraryHome
        data={
          {
            customer: { name: "Buyer", email: "buyer@example.com" },
            entries: [
              {
                grant: { id: GRANT_ID, status: "active", expires_at: null },
                product: {
                  title: "Private course",
                  subtitle: null,
                  kind: "course",
                  cover_url: null,
                },
                creator: {
                  username: "creator",
                  display_name: "Creator",
                  avatar_url: null,
                },
                order: null,
                canOpen: true,
              },
            ],
          } as never
        }
      />,
      { wrapper: Wrapper },
    );
    await waitFor(() => expect(registerTool).toHaveBeenCalledTimes(3));

    const controller = new AbortController();
    controller.abort();
    await expect(
      registeredTool("bento_open_customer_library_item").execute(
        { grantId: GRANT_ID },
        { signal: controller.signal },
      ),
    ).rejects.toThrow();
    await expect(
      registeredTool("bento_sign_out_customer_library").execute({}, { signal: controller.signal }),
    ).rejects.toThrow();

    expect(window.confirm).not.toHaveBeenCalled();
    expect(mocks.createAccess).not.toHaveBeenCalled();
    expect(mocks.logout).not.toHaveBeenCalled();
  });
});
