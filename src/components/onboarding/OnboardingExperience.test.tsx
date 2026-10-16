import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  buildManualCandidates,
  onboardingBriefSchema,
  continueWithoutOnboardingDrafts,
} from "@/lib/onboarding/brief";
const api = vi.hoisted(() => ({
  get: vi.fn(),
  save: vi.fn(),
  prepare: vi.fn(),
  edit: vi.fn(),
  approve: vi.fn(),
  activate: vi.fn(),
  checkout: vi.fn(),
  username: vi.fn(),
  export: vi.fn().mockResolvedValue("{}"),
}));
// Exercise the onboarding flow without depending on animation frames in JSDOM.
vi.mock("motion/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("motion/react")>();
  return { ...actual, useReducedMotion: () => true };
});
vi.mock("@/lib/onboarding/functions", () => ({
  getOnboarding: api.get,
  exportOnboardingContent: api.export,
  saveOnboarding: api.save,
  prepareOnboarding: api.prepare,
  editOnboardingCandidates: api.edit,
  approveOnboarding: api.approve,
  activateOnboarding: api.activate,
  importOnboardingSocial: vi.fn(),
  publishOnboardingPage: vi.fn(),
}));
vi.mock("@/lib/billing.functions", () => ({ createCheckout: api.checkout }));
vi.mock("@/lib/profile.functions", () => ({ checkUsername: api.username }));
vi.mock("@/lib/auth-entry", () => ({ clearOnboardedCache: vi.fn() }));
vi.mock("@/lib/referral.functions", () => ({
  consumeReferralAttribution: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/posthog", () => ({ captureProductEvent: vi.fn() }));
vi.mock("@/lib/social-connections.functions", () => ({ beginInstagramConnection: vi.fn() }));
vi.mock("@/lib/social-oauth.functions", () => ({ beginSocialConnection: vi.fn() }));
vi.mock("@/components/AuthShell", () => ({ AuthBrand: () => <a href="/">bento.surf</a> }));
import { OnboardingExperience } from "./OnboardingExperience";
import type { OnboardingSession } from "@/lib/onboarding/session.server";
let state: OnboardingSession;
let verified = false;
let trialEligible = true;
let selfHosted = false;
beforeEach(() => {
  vi.clearAllMocks();
  verified = false;
  trialEligible = true;
  selfHosted = false;
  sessionStorage.clear();
  state = {
    workspaceId: "workspace",
    revision: 0,
    step: 0,
    brief: onboardingBriefSchema.parse({ username: "my_studio" }),
    candidates: null,
    status: "draft",
    jobStatus: "idle",
    jobError: null,
    generationCount: 0,
    threadId: null,
  };
  api.get.mockImplementation(async () => ({
    session: structuredClone(state),
    connections: [],
    plan: verified ? "creator_plus" : "free",
    trialEndsAt: verified ? "2099-01-01T00:00:00Z" : null,
    currentUsername: "my_studio",
    selfHosted,
    trialEligible,
  }));
  api.save.mockImplementation(async ({ data }) => {
    state = { ...state, brief: data.brief, step: data.step, revision: state.revision + 1 };
    return structuredClone(state);
  });
  api.prepare.mockImplementation(async () => {
    state = {
      ...state,
      candidates: {
        ...buildManualCandidates(state.brief),
        drafts: [1, 2, 3].map((i) => ({
          title: `Draft ${i}`,
          body: `A useful photography idea ${i}.`,
        })),
      },
      jobStatus: "ready",
      generationCount: 1,
    };
    return structuredClone(state);
  });
  api.edit.mockImplementation(async ({ data }) => {
    state = { ...state, candidates: data.candidates, revision: state.revision + 1 };
    return structuredClone(state);
  });
  api.approve.mockImplementation(async ({ data }) => {
    state = { ...state, candidates: data.candidates, status: "prepared", step: 5 };
    return structuredClone(state);
  });
  api.activate.mockImplementation(async () => {
    if (!verified)
      throw new Error("Your card checkout is still being verified. Your preparation is saved.");
    state = {
      ...state,
      status: "applied",
      step: 6,
      threadId: "10000000-0000-4000-8000-000000000001",
    };
    return structuredClone(state);
  });
  api.checkout.mockResolvedValue({ url: "" });
});
function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <OnboardingExperience />
    </QueryClientProvider>,
  );
}
describe("prepared work → card checkout → usable results", () => {
  it("keeps the magic moment behind verified activation while showing personal proof before checkout", async () => {
    mount();
    fireEvent.click(await screen.findByRole("button", { name: /Build my Bento/ }));
    fireEvent.click(await screen.findByRole("button", { name: /Continue without connecting/ }));
    fireEvent.change(await screen.findByLabelText(/What should we call you/), {
      target: { value: "Ari" },
    });
    fireEvent.change(screen.getByLabelText(/What do you know or create/), {
      target: { value: "Photography" },
    });
    fireEvent.change(screen.getByLabelText(/Who do you want to help/), {
      target: { value: "New photographers" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Prepare my starting point/ }));
    await waitFor(() => expect(screen.getByText("A useful photography idea 1.")).toBeVisible());
    expect(api.checkout).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /Use this Brain/ }));
    fireEvent.click(await screen.findByLabelText(/Publish this reviewed page/));
    fireEvent.click(screen.getByRole("button", { name: /Continue to plan & trial/ }));
    await waitFor(() => expect(screen.getByText("$0 today")).toBeVisible());
    expect(screen.getByText(/after 3 full days/)).toBeVisible();
    expect(screen.queryByText(/seven full days/)).not.toBeInTheDocument();
    expect(api.username).not.toHaveBeenCalled(); // The creator already owns this username.
    expect(screen.queryByRole("heading", { name: "Your Bento is ready." })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Already completed checkout/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent("still being verified");
    expect(state.status).toBe("prepared");
    verified = true;
    fireEvent.click(screen.getByRole("button", { name: /Already completed checkout/ }));
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Your Bento is ready." })).toBeVisible(),
    );
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Your page is live" })).toBeVisible(),
    );
    expect(screen.getByRole("link", { name: /Open my drafts/ })).toHaveAttribute(
      "href",
      expect.stringContaining("thread=10000000"),
    );
  }, 15_000);
  it("resumes saved preparation without generating another starter batch", async () => {
    state = {
      ...state,
      step: 4,
      candidates: buildManualCandidates(
        onboardingBriefSchema.parse({
          username: "my_studio",
          displayName: "Ari",
          expertise: "Photography",
          audience: "Beginners",
        }),
      ),
    };
    mount();
    expect(await screen.findByLabelText(/Your Bento link/)).toHaveValue("my_studio");
    expect(api.prepare).not.toHaveBeenCalled();
  });
  it("autosaves reviewed Brain edits and restores them on resume", async () => {
    state = {
      ...state,
      step: 3,
      candidates: buildManualCandidates(
        onboardingBriefSchema.parse({
          username: "my_studio",
          displayName: "Ari",
          expertise: "Photography",
          audience: "Beginners",
        }),
      ),
    };
    const view = mount();
    const voice = await screen.findByLabelText("Writing voice");
    fireEvent.change(voice, { target: { value: "Plain language. No jargon. Short examples." } });
    await waitFor(() => expect(api.edit).toHaveBeenCalled(), { timeout: 2000 });
    await waitFor(() =>
      expect(state.candidates?.brain[1].content).toBe("Plain language. No jargon. Short examples."),
    );
    view.unmount();
    mount();
    expect(await screen.findByLabelText("Writing voice")).toHaveValue(
      "Plain language. No jargon. Short examples.",
    );
  });
  it("discloses the immediate recurring charge after an owner has used their trial", async () => {
    trialEligible = false;
    state = {
      ...state,
      step: 5,
      status: "prepared",
      candidates: buildManualCandidates(state.brief),
    };
    mount();
    expect(await screen.findByText("$19 today")).toBeVisible();
    expect(screen.queryByText("$0 today")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Activate my plan" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: /Yearly · 2 months free/ }));
    expect(screen.getByText("$190 today")).toBeVisible();
    expect(screen.getByText(/\$190\/year, plus applicable taxes/)).toBeVisible();
  });
  it("shows Free Forever self-hosted setup without card or subscription copy", async () => {
    selfHosted = true;
    mount();
    expect(await screen.findByText(/Free Forever, on your own infrastructure/)).toBeVisible();
    expect(screen.queryByText(/A card is required/)).not.toBeInTheDocument();
  });
  it("keeps content export available when hosted trial access has expired", async () => {
    state = {
      ...state,
      status: "applied",
      step: 6,
      candidates: buildManualCandidates(state.brief),
    };
    mount();
    expect(
      await screen.findByRole("button", { name: "Download my Brain and saved drafts" }),
    ).toBeVisible();
    expect(screen.getByRole("link", { name: /Review my billing/ })).toBeVisible();
  });
});

it("continues manually with exhausted legacy drafts and shows only active starter count", async () => {
  state.brief = onboardingBriefSchema.parse({
    username: "my_studio",
    displayName: "Ari",
    expertise: "Photography",
    audience: "Beginners",
    platform: "instagram",
  });
  state.step = 3;
  state.generationCount = 2;
  state.jobStatus = "ready";
  state.candidates = {
    ...buildManualCandidates(state.brief),
    drafts: [{ title: "Earlier draft", body: "Saved legacy copy" }],
  };
  api.prepare.mockImplementation(async ({ data }) => {
    expect(data.generate).toBe(false);
    state = {
      ...state,
      candidates: continueWithoutOnboardingDrafts(state.candidates!),
      jobStatus: "ready",
    };
    return structuredClone(state);
  });
  mount();
  expect(await screen.findByRole("button", { name: "Refresh my drafts" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Use my answers without AI drafts" }));
  await waitFor(() => expect(screen.queryByText("Saved legacy copy")).not.toBeInTheDocument());
  fireEvent.click(screen.getByRole("button", { name: /Use this Brain/ }));
  expect(await screen.findByText("Starter drafts: 0")).toBeVisible();
  expect(screen.getByText(/earlier drafts saved in your preparation download/)).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: /Continue to plan & trial/ }));
  await waitFor(() =>
    expect(api.approve).toHaveBeenCalledWith({
      data: expect.objectContaining({
        allowPartial: true,
        candidates: expect.objectContaining({
          drafts: [],
          deferredDrafts: [{ title: "Earlier draft", body: "Saved legacy copy" }],
        }),
      }),
    }),
  );
  expect(await screen.findByText(/0 starter drafts/)).toBeVisible();
});
