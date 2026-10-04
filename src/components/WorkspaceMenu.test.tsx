import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AnchorHTMLAttributes, ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceSession } from "@/lib/workspace-session.server";

const events: string[] = [];
const mocks = vi.hoisted(() => ({
  clear: vi.fn(() => events.push("clear")),
  cancelQueries: vi.fn(async () => undefined),
  invalidateQueries: vi.fn(async () => undefined),
  routerInvalidate: vi.fn(async () => events.push("invalidate")),
  setTheme: vi.fn(),
  switchWorkspace: vi.fn(),
  updateAccountPreference: vi.fn(),
  signOut: vi.fn(),
}));

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({
    clear: mocks.clear,
    cancelQueries: mocks.cancelQueries,
    invalidateQueries: mocks.invalidateQueries,
  }),
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({
    to,
    children,
    ...props
  }: AnchorHTMLAttributes<HTMLAnchorElement> & {
    to: string;
    children: ReactNode;
  }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
  useRouter: () => ({ invalidate: mocks.routerInvalidate }),
}));
vi.mock("next-themes", () => ({ useTheme: () => ({ setTheme: mocks.setTheme }) }));
vi.mock("@/lib/workspace.functions", () => ({
  switchWorkspace: mocks.switchWorkspace,
  updateAccountPreference: mocks.updateAccountPreference,
}));
vi.mock("@/integrations/supabase/client", () => ({
  supabase: { auth: { signOut: mocks.signOut } },
}));

import { WorkspaceMenu } from "./WorkspaceMenu";

const session: WorkspaceSession = {
  authUserId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  workspace: {
    id: "22222222-2222-4222-8222-222222222222",
    username: "main",
    displayName: "Main Studio",
    avatarUrl: null,
    status: "active",
    plan: "creator",
  },
  workspaces: [
    {
      id: "22222222-2222-4222-8222-222222222222",
      username: "main",
      displayName: "Main Studio",
      avatarUrl: null,
      status: "active",
      plan: "creator",
    },
    {
      id: "33333333-3333-4333-8333-333333333333",
      username: "second",
      displayName: "Second Studio",
      avatarUrl: null,
      status: "active",
      plan: "creator",
    },
    {
      id: "44444444-4444-4444-8444-444444444444",
      username: "pending",
      displayName: "Pending Studio",
      avatarUrl: null,
      status: "pending",
      plan: "free",
    },
  ],
  appTheme: "light",
};

beforeEach(() => {
  vi.clearAllMocks();
  events.length = 0;
  mocks.switchWorkspace.mockResolvedValue({ ...session, workspaceId: session.workspaces[1].id });
  mocks.updateAccountPreference.mockResolvedValue({ appTheme: "dark" });
  mocks.signOut.mockResolvedValue({ error: null });
});

describe("WorkspaceMenu", () => {
  it("shows current, active, pending, account, and profile actions", async () => {
    const user = userEvent.setup();
    render(<WorkspaceMenu session={session} collapsed={false} />);
    await user.click(screen.getByRole("button", { name: "Open workspace menu" }));

    expect(await screen.findByRole("menuitem", { name: /Main Studio/ })).toBeInTheDocument();
    expect(screen.getByText("Current")).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /Second Studio/ })).toBeEnabled();
    expect(
      screen.getByRole("menuitem", { name: /Pending Studio.*Awaiting payment/ }),
    ).toHaveAttribute("data-disabled");
    expect(screen.getByRole("menuitem", { name: "Add another profile" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Turn dark mode on" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Billing" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Settings" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Sign out" })).toBeInTheDocument();
  });

  it("clears cached workspace data before invalidating after a switch", async () => {
    const user = userEvent.setup();
    render(<WorkspaceMenu session={session} collapsed={false} />);
    await user.click(screen.getByRole("button", { name: "Open workspace menu" }));
    await user.click(await screen.findByRole("menuitem", { name: /Second Studio/ }));

    await waitFor(() => expect(mocks.routerInvalidate).toHaveBeenCalled());
    expect(mocks.switchWorkspace).toHaveBeenCalledWith({
      data: { workspaceId: session.workspaces[1].id },
    });
    expect(events).toEqual(["clear", "invalidate"]);
  });

  it("stores the universal theme preference before applying it", async () => {
    const user = userEvent.setup();
    render(<WorkspaceMenu session={session} collapsed={false} />);
    await user.click(screen.getByRole("button", { name: "Open workspace menu" }));
    await user.click(await screen.findByRole("menuitem", { name: "Turn dark mode on" }));

    await waitFor(() => expect(mocks.setTheme).toHaveBeenCalledWith("dark"));
    expect(mocks.updateAccountPreference).toHaveBeenCalledWith({ data: { appTheme: "dark" } });
    expect(mocks.updateAccountPreference.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.setTheme.mock.invocationCallOrder[0],
    );
  });
});
