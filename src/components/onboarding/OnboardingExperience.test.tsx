import { rememberCheckoutForRecovery } from "@/lib/checkout-recovery";
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
  workspace: vi.fn(),
  switchWorkspace: vi.fn(),
  navigate: vi.fn(),
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => api.navigate }));
vi.mock("@/lib/workspace.functions", () => ({
  getWorkspaceSession: api.workspace,
  switchWorkspace: api.switchWorkspace,
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
vi.mock("@/lib/checkout-tracking", () => ({
  beginCheckoutTracking: vi.fn(),
  forceCheckoutReplay: vi.fn(),
  forceOnboardingReplay: vi.fn(),
}));
vi.mock("@/lib/social-connections.functions", () => ({ beginInstagramConnection: vi.fn() }));
vi.mock("@/lib/social-oauth.functions", () => ({ beginSocialConnection: vi.fn() }));
vi.mock("@/components/AuthShell", () => ({
  AuthBrand: ({ linked = true }: { linked?: boolean }) =>
    linked ? <a href="/">bento.surf</a> : <span>bento.surf</span>,
}));
import { OnboardingExperience } from "./OnboardingExperience";
import { captureProductEvent } from "@/lib/posthog";
import { forceCheckoutReplay } from "@/lib/checkout-tracking";

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
  localStorage.clear();
  window.history.replaceState({}, "", "/");
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
    fullyManagedCheckoutAvailable: true,
    trialEligible: true,
  }));
  api.username.mockResolvedValue({ available: true });
  api.workspace.mockResolvedValue({ workspaceId: "workspace", workspaces: [] });
  api.switchWorkspace.mockResolvedValue(undefined);
  api.navigate.mockResolvedValue(undefined);
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

function withMainWorkspace() {
  api.workspace.mockResolvedValue({
    workspaceId: "workspace",
    workspaces: [
      { id: "main-workspace", displayName: "Main Studio", status: "active" },
      { id: "workspace", displayName: "Second Studio", status: "pending" },
    ],
  });
}

it("saves second-workspace answers before returning to the main workspace", async () => {
  withMainWorkspace();
  mount();
  fireEvent.change(await screen.findByLabelText("Your Bento username"), {
    target: { value: "second_studio" },
  });
  fireEvent.click(await screen.findByRole("button", { name: "Back to Main Studio" }));
  await waitFor(() =>
    expect(api.navigate).toHaveBeenCalledWith({ to: "/home", reloadDocument: true }),
  );
  expect(state.brief.username).toBe("second_studio");
  expect(api.switchWorkspace).toHaveBeenCalledWith({ data: { workspaceId: "main-workspace" } });
  expect(api.save.mock.invocationCallOrder[0]).toBeLessThan(
    api.switchWorkspace.mock.invocationCallOrder[0],
  );
});

it("offers a way back while second-workspace generation is running", async () => {
  withMainWorkspace();
  state = { ...state, step: 3, brief: profile(), jobStatus: "running" };
  mount();
  expect(await screen.findByRole("button", { name: "Back to Main Studio" })).toBeEnabled();
  fireEvent.click(screen.getByRole("button", { name: "Back to Main Studio" }));
  await waitFor(() => expect(api.navigate).toHaveBeenCalled());
  expect(api.save).not.toHaveBeenCalled();
});

it("lets an additional workspace return while its preparation request is still waiting", async () => {
  withMainWorkspace();
  state = { ...state, step: 2, brief: profile() };
  api.prepare.mockImplementation(() => new Promise(() => undefined));
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "Meet my Brain" }));
  await waitFor(() => expect(api.prepare).toHaveBeenCalledOnce());
  expect(screen.getByRole("button", { name: "Back to Main Studio" })).toBeEnabled();
  fireEvent.click(screen.getByRole("button", { name: "Back to Main Studio" }));
  await waitFor(() => expect(api.navigate).toHaveBeenCalled());
});

it("keeps a completed preparation usable if a concurrent workspace switch fails", async () => {
  withMainWorkspace();
  state = { ...state, step: 2, brief: profile() };
  let finishPreparation!: (value: OnboardingSession) => void;
  let failSwitch!: (cause: Error) => void;
  api.prepare.mockImplementation(
    () =>
      new Promise((resolve) => {
        finishPreparation = resolve;
      }),
  );
  api.switchWorkspace.mockImplementationOnce(
    () =>
      new Promise((_, reject) => {
        failSwitch = reject;
      }),
  );
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "Meet my Brain" }));
  await waitFor(() => expect(api.prepare).toHaveBeenCalledOnce());
  fireEvent.click(screen.getByRole("button", { name: "Back to Main Studio" }));
  await waitFor(() => expect(api.switchWorkspace).toHaveBeenCalledOnce());
  state = { ...state, candidates: prepared(), jobStatus: "ready" };
  finishPreparation(structuredClone(state));
  await screen.findByRole("heading", { name: "Meet your Brain, Ari." });
  failSwitch(new Error("Workspace temporarily unavailable."));
  expect(await screen.findByRole("alert")).toHaveTextContent("Workspace temporarily unavailable");
  expect(screen.getByRole("button", { name: "Back to Main Studio" })).toBeEnabled();
});

it("offers a way back even when setup fails to load", async () => {
  withMainWorkspace();
  api.get.mockRejectedValue(new Error("Setup unavailable"));
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "Back to Main Studio" }));
  await waitFor(() => expect(api.navigate).toHaveBeenCalled());
  expect(api.save).not.toHaveBeenCalled();
});

it("keeps setup accessible and explains a failed workspace switch", async () => {
  withMainWorkspace();
  api.switchWorkspace.mockRejectedValueOnce(new Error("Workspace could not be opened. Try again."));
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "Back to Main Studio" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Workspace could not be opened");
  expect(api.navigate).not.toHaveBeenCalled();
  expect(screen.getByLabelText("Your Bento username")).toBeVisible();
});

it("does not offer a main-workspace return during first-workspace setup", async () => {
  api.workspace.mockResolvedValue({
    workspaceId: "main-workspace",
    workspaces: [
      { id: "main-workspace", displayName: "Main Studio", status: "pending" },
      { id: "other-workspace", displayName: "Other Studio", status: "active" },
    ],
  });
  mount();
  await screen.findByLabelText("Your Bento username");
  expect(screen.queryByRole("button", { name: /^Back to / })).not.toBeInTheDocument();
});

it("uses the original workspace's name when several other workspaces exist", async () => {
  api.workspace.mockResolvedValue({
    workspaceId: "workspace",
    workspaces: [
      { id: "main-workspace", displayName: "Ari’s Photography", status: "active" },
      { id: "other-workspace", displayName: "Other Studio", status: "active" },
      { id: "workspace", displayName: "Second Studio", status: "pending" },
    ],
  });
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "Back to Ari’s Photography" }));
  await waitFor(() => expect(api.navigate).toHaveBeenCalled());
  expect(api.switchWorkspace).toHaveBeenCalledWith({ data: { workspaceId: "main-workspace" } });
});

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
  // The request can return an already finished job; the outcome is still reported once.
  const outcomes = vi
    .mocked(captureProductEvent)
    .mock.calls.filter(
      ([event]) => event === "brain_draft_succeeded" || event === "brain_draft_failed",
    );
  expect(outcomes).toHaveLength(1);
  expect(outcomes[0][1]).toMatchObject({ platform: expect.any(String), generation: 1 });
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
  // Free workspaces see the capability showcase right before the trial step.
  expect(await screen.findByTestId("capability-showcase")).toBeVisible();
  await waitFor(() =>
    expect(captureProductEvent).toHaveBeenCalledWith(
      "onboarding_showcase_viewed",
      expect.objectContaining({ items: 5 }),
    ),
  );
  fireEvent.click(screen.getByRole("button", { name: /Choose my plan/ }));
  expect(await screen.findByRole("button", { name: "Start my 3-day trial" })).toBeVisible();
  // Reaching the trial step always records the session, even when it was not sampled.
  expect(forceCheckoutReplay).toHaveBeenCalled();
  expect(screen.getByText(/Then \$99\/month after 3 days/)).toBeVisible();
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

it("offers another draft attempt from checkout when generation failed", async () => {
  state = {
    ...state,
    step: 5,
    status: "prepared",
    brief: profile(),
    candidates: buildManualCandidates(profile()),
    jobStatus: "failed",
    jobError:
      "I couldn't finish generating and checking this draft. This starter uses only the answers you already gave. You can edit it, try again, or continue and publish your page.",
    generationCount: 1,
  };
  mount();
  expect(await screen.findByRole("button", { name: "Start my 3-day trial" })).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Try the draft again" }));
  await waitFor(() => expect(api.prepare).toHaveBeenCalledOnce());
  expect(api.checkout).not.toHaveBeenCalled();
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

it("keeps the draft on screen while approving instead of flashing the Brain progress screen", async () => {
  state = { ...state, step: 3, brief: profile(), candidates: prepared(), jobStatus: "ready" };
  let finishApproval: () => void = () => undefined;
  api.approve.mockImplementation(
    ({ data }) =>
      new Promise((resolve) => {
        finishApproval = () => {
          state = { ...state, candidates: data.candidates, status: "prepared", step: 5 };
          resolve(structuredClone(state));
        };
      }),
  );
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "See my first draft" }));
  expect(await screen.findByText(prepared().drafts[0].body)).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "This feels like me" }));
  await waitFor(() => expect(api.approve).toHaveBeenCalledOnce());
  // While the approval request is in flight the draft stays put and the button shows it is busy.
  expect(screen.queryByText(/Connecting the dots/)).not.toBeInTheDocument();
  expect(screen.getByText(prepared().drafts[0].body)).toBeVisible();
  expect(screen.getByRole("button", { name: "This feels like me" })).toBeDisabled();
  finishApproval();
  expect(await screen.findByTestId("capability-showcase")).toBeVisible();
  expect(screen.queryByText(/Connecting the dots/)).not.toBeInTheDocument();
});

it("shows the question counter and records each visible question once", async () => {
  state.step = 2;
  mount();
  expect(await screen.findByText("Question 1 of 3")).toBeInTheDocument();
  await waitFor(() =>
    expect(captureProductEvent).toHaveBeenCalledWith(
      "onboarding_step_viewed",
      expect.objectContaining({ step: 2, step_name: "questions", question: "displayName" }),
    ),
  );
  expect(document.querySelector("main")?.getAttribute("translate")).toBe("no");
  expect(document.querySelector("main")?.classList.contains("notranslate")).toBe(true);
  expect(screen.queryByRole("link", { name: "bento.surf" })).not.toBeInTheDocument();
});

it("recovers a completed Brain when the preparation response is lost", async () => {
  state.step = 2;
  state.brief = profile();
  api.prepare.mockImplementationOnce(async () => {
    state = { ...state, candidates: prepared(), jobStatus: "ready", generationCount: 1 };
    throw new TypeError("Load failed");
  });
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "Meet my Brain" }));
  expect(await screen.findByRole("heading", { name: "Meet your Brain, Ari." })).toBeVisible();
  expect(screen.queryByText(/Connecting the dots/)).not.toBeInTheDocument();
  expect(captureProductEvent).toHaveBeenCalledWith(
    "brain_draft_succeeded",
    expect.objectContaining({ generation: 1 }),
  );
});

it("shows recovery on the initial identity step", async () => {
  rememberCheckoutForRecovery({
    plan: "creator",
    period: "yearly",
    trial: true,
    surface: "upgrade_dialog",
  });
  mount();
  expect(await screen.findByText("Checkout didn't finish")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Try checkout again" })).toBeTruthy();
});
it("retries the saved plan and interval on a failed checkout return", async () => {
  rememberCheckoutForRecovery({
    plan: "creator",
    period: "yearly",
    trial: true,
    surface: "upgrade_dialog",
  });
  window.history.replaceState({}, "", "/?checkout=1&status=failed");
  state = { ...state, status: "prepared", step: 5, brief: profile(), candidates: prepared() };
  mount();
  await screen.findByRole("button", { name: "Try another card" });
  expect(screen.queryByText("Checkout didn't finish")).toBeNull();
});
it("hides recovery with hosted access", async () => {
  verified = true;
  rememberCheckoutForRecovery({
    plan: "creator",
    period: "yearly",
    trial: true,
    surface: "upgrade_dialog",
  });
  mount();
  await screen.findByRole("textbox");
  expect(screen.queryByText("Checkout didn't finish")).toBeNull();
});

it("retries the same onboarding plan and interval with retry analytics", async () => {
  rememberCheckoutForRecovery({
    plan: "store",
    period: "yearly",
    trial: true,
    surface: "upgrade_dialog",
  });
  api.checkout.mockResolvedValue({ url: "https://checkout.dodopayments.com/test" });
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "Try checkout again" }));
  await waitFor(() =>
    expect(api.checkout).toHaveBeenCalledWith({
      data: expect.objectContaining({ plan: "store", period: "yearly" }),
    }),
  );
  await waitFor(() =>
    expect(captureProductEvent).toHaveBeenCalledWith(
      "checkout_started",
      expect.objectContaining({
        plan: "store",
        billing_interval: "yearly",
        retry: true,
        surface: "onboarding_trial_step",
      }),
    ),
  );
  expect(captureProductEvent).toHaveBeenCalledWith(
    "trial_cta_clicked",
    expect.objectContaining({
      plan: "store",
      billing_interval: "yearly",
      retry: true,
      surface: "onboarding_trial_step",
    }),
  );
  expect(captureProductEvent).toHaveBeenCalledWith(
    "checkout_recovery_retry_clicked",
    expect.objectContaining({
      plan: "store",
      original_surface: "upgrade_dialog",
      surface: "onboarding",
    }),
  );
});
