import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { BennyPresenterSettings } from "./BennyPresenterSettings";
import { DEFAULT_AGENT_BRANDING } from "@/lib/content-agent-branding";
const f = vi.hoisted(() => ({ avatars: vi.fn(), voices: vi.fn() }));
vi.mock("@/lib/external-tools.functions", () => ({
  listHeyGenAvatars: f.avatars,
  listHeyGenVoices: f.voices,
}));
beforeEach(() => {
  vi.clearAllMocks();
  f.avatars.mockResolvedValue({
    avatars: [
      {
        id: "look",
        name: "Annie",
        previewImageUrl: "https://cdn.example.com/look.jpg",
        defaultVoiceId: "voice",
      },
    ],
    nextToken: null,
  });
  f.voices.mockResolvedValue({
    voices: [{ id: "voice", name: "Narrator", language: "English" }],
    nextToken: null,
  });
});
it("browses real authorized choices only on request and stages a reusable default locally", async () => {
  const onChange = vi.fn();
  render(<BennyPresenterSettings brand={DEFAULT_AGENT_BRANDING} onChange={onChange} />);
  expect(f.avatars).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Browse presenter looks" }));
  await screen.findByRole("button", { name: "Use Annie" });
  expect(f.avatars).toHaveBeenCalledWith({
    data: { billing: "managed", scope: "public", token: undefined },
  });
  fireEvent.click(screen.getByRole("button", { name: "Use Annie" }));
  expect(onChange).toHaveBeenCalledWith({
    ...DEFAULT_AGENT_BRANDING,
    presenter: {
      avatarId: "look",
      name: "Annie",
      voiceId: "voice",
      billing: "managed",
      scope: "public",
    },
  });
});
it("keeps a saved face on catalog failure and permits clearing without any provider read", async () => {
  const onChange = vi.fn();
  const brand = {
    ...DEFAULT_AGENT_BRANDING,
    presenter: {
      avatarId: "look",
      name: "Annie",
      voiceId: "voice",
      billing: "managed" as const,
      scope: "public" as const,
    },
  };
  render(<BennyPresenterSettings brand={brand} onChange={onChange} />);
  expect(screen.getByText("Annie")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Clear presenter selection" }));
  expect(onChange).toHaveBeenCalledWith({ ...brand, presenter: null });
  expect(f.avatars).not.toHaveBeenCalled();
  f.avatars.mockRejectedValue(new Error("Catalog unavailable"));
  fireEvent.click(screen.getByRole("button", { name: "Browse presenter looks" }));
  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Catalog unavailable"));
  expect(screen.getByText("Annie")).toBeVisible();
});
