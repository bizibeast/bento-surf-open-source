import { beforeEach, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { buildManualCandidates, onboardingBriefSchema } from "@/lib/onboarding/brief";
import type { OnboardingSession } from "@/lib/onboarding/session.server";
import type { OnboardingConnection } from "./OnboardingScreens";

const api = vi.hoisted(() => ({
  get: vi.fn(),
  save: vi.fn(),
  prepare: vi.fn(),
  edit: vi.fn(),
  approve: vi.fn(),
  activate: vi.fn(),
  checkout: vi.fn(),
  username: vi.fn(),
  import: vi.fn(),
  export: vi.fn(),
  publish: vi.fn(),
}));
vi.mock("motion/react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("motion/react")>()),
  useReducedMotion: () => true,
}));
vi.mock("@/lib/onboarding/functions", () => ({
  getOnboarding: api.get,
  saveOnboarding: api.save,
  prepareOnboarding: api.prepare,
  editOnboardingCandidates: api.edit,
  approveOnboarding: api.approve,
  activateOnboarding: api.activate,
  importOnboardingSocial: api.import,
  exportOnboardingContent: api.export,
  publishOnboardingPage: api.publish,
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

let state: OnboardingSession;
let connections: OnboardingConnection[];
let verified: boolean;
const profile = () =>
  onboardingBriefSchema.parse({
    username: "my_studio",
    displayName: "Ari",
    expertise: "Photography",
    audience: "New photographers",
    platform: "linkedin",
  });
const prepared = () => ({
  ...buildManualCandidates(profile()),
  drafts: [
    {
      title: "One useful decision",
      body: "Start with one window and watch how the light changes before buying another lamp.",
      platform: "linkedin" as const,
      format: "post" as const,
    },
  ],
});
beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(window, "scrollTo").mockImplementation(() => undefined);
  sessionStorage.clear();
  verified = false;
  connections = [];
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
    connections,
    plan: verified ? "creator_plus" : "free",
    trialEndsAt: null,
    currentUsername: "my_studio",
    selfHosted: false,
    trialEligible: true,
  }));
  api.username.mockResolvedValue({ available: true });
  api.save.mockImplementation(async ({ data }) => {
    const brief = onboardingBriefSchema.parse(data.brief);
    state = { ...state, brief, step: data.step, revision: state.revision + 1 };
    return structuredClone(state);
  });
  api.prepare.mockImplementation(async () => {
    state = { ...state, candidates: prepared(), jobStatus: "ready", generationCount: 1 };
    return structuredClone(state);
  });
  api.import.mockResolvedValue({
    displayName: "Ari",
    bio: "Photography",
    avatarUrl: "https://example.com/ari.jpg",
    primaryConnectionId: "11111111-1111-4111-8111-111111111111",
    links: [],
    writingSample: "One useful photo tip.",
    importedPosts: 3,
  });
  api.edit.mockImplementation(async ({ data }) => {
    state = {
      ...state,
      candidates: { ...data.candidates, drafts: [] },
      revision: state.revision + 1,
    };
    return structuredClone(state);
  });
  api.approve.mockImplementation(async ({ data }) => {
    state = { ...state, candidates: data.candidates, status: "prepared", step: 5 };
    return structuredClone(state);
  });
  api.activate.mockImplementation(async () => {
    if (!verified) throw new Error("Your checkout is still being verified.");
    state = { ...state, status: "applied", step: 6, threadId: "thread" };
    return structuredClone(state);
  });
  api.checkout.mockRejectedValue(new Error("Test checkout boundary"));
});
function mount() {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
        })
      }
    >
      <OnboardingExperience />
    </QueryClientProvider>,
  );
}

it("asks for the username first and checks availability before social connection", async () => {
  mount();
  const username = await screen.findByLabelText("Your Bento username");
  expect(username).toHaveValue("my_studio");
  expect(screen.queryByText("Draft platform")).not.toBeInTheDocument();
  fireEvent.change(username, { target: { value: "already_taken" } });
  api.username.mockResolvedValue({ available: false });
  fireEvent.click(screen.getByRole("button", { name: "Make it mine" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("already taken");
  expect(api.save).not.toHaveBeenCalled();
});

it("puts connected identity in platform buttons and continues after just one connection", async () => {
  state.step = 1;
  connections = [
    {
      id: "11111111-1111-4111-8111-111111111111",
      provider: "instagram",
      provider_handle: "ari_studio",
      provider_display_name: "Ari",
      provider_avatar_url: "https://example.com/ari.jpg",
    },
  ];
  mount();
  expect(
    await screen.findByRole("button", { name: "Instagram connected as ari_studio" }),
  ).toHaveTextContent("@ari_studio");
  expect(screen.queryByText("Use profile")).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Continue without connecting" }),
  ).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  const audience = await screen.findByLabelText(
    "Who is your target audience that you want to help?",
  );
  expect(screen.queryByLabelText("What should we call you?")).not.toBeInTheDocument();
  expect(api.import).toHaveBeenCalledOnce();
  expect(api.save.mock.calls[0][0].data.brief).not.toHaveProperty("importedPosts");
  fireEvent.change(audience, { target: { value: "New photographers" } });
  fireEvent.click(screen.getByRole("button", { name: "Meet my Brain" }));
  expect(await screen.findByRole("heading", { name: "Meet your Brain, Ari." })).toBeVisible();
  expect(api.prepare).toHaveBeenCalledOnce();
});

it("asks one missing question at a time when no account is connected", async () => {
  state.step = 1;
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "Continue without connecting" }));
  fireEvent.change(await screen.findByLabelText("What should we call you?"), {
    target: { value: "Ari" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  fireEvent.change(await screen.findByLabelText("What do you create or know best?"), {
    target: { value: "Photography" },
  });
  expect(
    screen.queryByLabelText("Who is your target audience that you want to help?"),
  ).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  expect(
    await screen.findByLabelText("Who is your target audience that you want to help?"),
  ).toBeVisible();
  expect(api.prepare).not.toHaveBeenCalled();
});

it("shows personal proof before payment, then activates only after verified checkout", async () => {
  state = { ...state, step: 3, brief: profile(), candidates: prepared(), jobStatus: "ready" };
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "See my first draft" }));
  expect(await screen.findByText(prepared().drafts[0].body)).toBeVisible();
  expect(api.checkout).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "This feels like me" }));
  expect(await screen.findByRole("button", { name: "Start my 3-day trial" })).toBeVisible();
  expect(screen.getByText(/Then \$49\/month after 3 days/)).toBeVisible();
  expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  expect(screen.queryByRole("heading", { name: "Your Bento is ready." })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Already checked out? Verify access" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("still being verified");
  verified = true;
  fireEvent.click(screen.getByRole("button", { name: "Already checked out? Verify access" }));
  expect(await screen.findByRole("heading", { name: "Your Bento is ready." })).toBeVisible();
  expect(screen.getByRole("link", { name: "Open my workspace" })).toHaveAttribute(
    "href",
    expect.stringContaining("thread=thread"),
  );
  expect(api.publish).not.toHaveBeenCalled();
});

it("activates existing granted access without checkout or a new trial", async () => {
  verified = true;
  state = {
    ...state,
    step: 4,
    brief: profile(),
    candidates: buildManualCandidates(profile()),
    jobStatus: "ready",
  };
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "Continue with my Brain" }));
  expect(await screen.findByRole("heading", { name: "Your Bento is ready." })).toBeVisible();
  expect(api.approve).toHaveBeenCalledWith({
    data: expect.objectContaining({ allowPartial: true }),
  });
  expect(api.checkout).not.toHaveBeenCalled();
});

it("saves chapter edits and removes drafts based on the older Brain", async () => {
  state = { ...state, step: 3, brief: profile(), candidates: prepared(), jobStatus: "ready" };
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
  fireEvent.change(screen.getByLabelText("Edit My Human"), {
    target: { value: "I teach portrait photography to new photographers." },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save this chapter" }));
  await waitFor(() => expect(api.edit).toHaveBeenCalledOnce(), { timeout: 2500 });
  expect(await screen.findByRole("button", { name: "Continue with my Brain" })).toBeVisible();
  expect(api.prepare).not.toHaveBeenCalled();
});

it("resumes an older page-review step directly in the personal Brain", async () => {
  state = { ...state, step: 4, brief: profile(), candidates: prepared(), jobStatus: "ready" };
  mount();
  expect(await screen.findByRole("heading", { name: "Meet your Brain, Ari." })).toBeVisible();
  expect(api.prepare).not.toHaveBeenCalled();
  expect(screen.queryByLabelText("Your Bento username")).not.toBeInTheDocument();
});

it("restores the username chosen before signup", async () => {
  sessionStorage.setItem("pending_username", "ari_creates");
  mount();
  expect(await screen.findByLabelText("Your Bento username")).toHaveValue("ari_creates");
});
