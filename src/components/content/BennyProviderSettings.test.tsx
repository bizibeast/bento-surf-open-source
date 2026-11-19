import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { BennyProviderForm } from "./BennyProviderSettings";

const actions = vi.hoisted(() => ({
  models: vi.fn(),
  save: vi.fn(),
  setDefault: vi.fn(),
}));

vi.mock("@/lib/benny-byok.functions", () => ({
  getBennyAiModels: actions.models,
  saveBennyAiProvider: actions.save,
  updateBennyAiDefault: actions.setDefault,
  removeBennyAiProvider: vi.fn(),
  updateBennySearchKey: vi.fn(),
}));

beforeEach(() => {
  vi.resetAllMocks();
  actions.models.mockResolvedValue([{ id: "openai/sample", name: "Sample", jsonMode: true }]);
  actions.save.mockResolvedValue({ id: "saved-provider" });
  actions.setDefault.mockResolvedValue(undefined);
});

it("lets a first-time user test their key and make the chosen model the default", async () => {
  const user = userEvent.setup();
  const onChange = vi.fn().mockResolvedValue(undefined);
  render(
    <BennyProviderForm
      preferences={{ defaultProviderId: null, providers: [] }}
      onChange={onChange}
    />,
  );

  const key = "fixture-key-for-testing";
  const keyField = screen.getByLabelText("OpenRouter API key");
  expect(keyField).toHaveAttribute("type", "password");
  await user.type(keyField, key);
  await user.click(screen.getByRole("button", { name: "Test key and load models" }));
  expect(actions.models).toHaveBeenCalledWith({ data: { apiKey: key, kind: "openrouter" } });

  await user.type(screen.getByLabelText("Model ID", { exact: true }), "openai/sample");
  expect(
    screen.getByRole("checkbox", { name: "Use this as my default model in Benny and Studio" }),
  ).toBeChecked();
  await user.click(screen.getByRole("button", { name: "Add connection" }));

  expect(await screen.findByText("Connection saved as your default model.")).toBeVisible();
  expect(actions.save).toHaveBeenCalledWith({
    data: {
      apiKey: key,
      name: "OpenRouter",
      model: "openai/sample",
      kind: "openrouter",
      additionalModels: [],
    },
  });
  expect(actions.setDefault).toHaveBeenCalledWith({ data: { id: "saved-provider" } });
  expect(onChange).toHaveBeenCalledWith(true);
  expect(keyField).toHaveValue("");
});
