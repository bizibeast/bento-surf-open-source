import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CreemApiKeyDialog } from "./CreemApiKeyDialog";
import { DodoApiKeyDialog } from "./DodoApiKeyDialog";
import { PayPalApiCredentialsDialog } from "./PayPalApiCredentialsDialog";

vi.mock("@/integrations/dodo/connection.functions", () => ({
  connectDodoApiKey: vi.fn(),
  getMyDodoConnection: vi.fn(async () => null),
}));
vi.mock("@/integrations/paypal/connection.functions", () => ({
  connectPayPalApiCredentials: vi.fn(),
  getMyPayPalConnection: vi.fn(async () => null),
}));
vi.mock("@/integrations/creem/connection.functions", () => ({
  configureCreemWebhook: vi.fn(),
  connectCreemApiKey: vi.fn(),
  getMyCreemConnection: vi.fn(async () => null),
}));

afterEach(() => vi.unstubAllEnvs());

function renderDialog(component: React.ReactNode) {
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      {component}
    </QueryClientProvider>,
  );
}

describe("creator payment credential dialogs", () => {
  it.each([
    ["Dodo", <DodoApiKeyDialog open onOpenChange={vi.fn()} />, "Test", "Live"],
    ["PayPal", <PayPalApiCredentialsDialog open onOpenChange={vi.fn()} />, "Sandbox", "Live"],
  ])("defaults %s to its safe environment outside production", async (_, dialog, safe, live) => {
    vi.stubEnv("VITE_APP_ENV", "development");
    renderDialog(dialog);

    expect(await screen.findByRole("button", { name: safe })).toHaveClass("bg-card");
    expect(screen.getByRole("button", { name: live })).not.toHaveClass("bg-card");
  });

  it("defaults Creem to test outside production", async () => {
    vi.stubEnv("VITE_APP_ENV", "development");
    renderDialog(<CreemApiKeyDialog open onOpenChange={vi.fn()} />);

    expect(await screen.findByRole("combobox", { name: "Environment" })).toHaveValue("test");
  });
});
