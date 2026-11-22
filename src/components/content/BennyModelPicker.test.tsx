import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { BennyModelPicker } from "./BennyModelPicker";
it("opens the styled radio menu, selects a model and returns focus to the composer control", async () => {
  const user = userEvent.setup();
  const onChange = vi.fn();
  render(
    <BennyModelPicker
      value="one"
      options={[
        { value: "one", label: "GPT 6.2 Astra" },
        { value: "two", label: "Gemini 4 Neon" },
      ]}
      onChange={onChange}
    />,
  );
  const trigger = screen.getByRole("button", { name: "Benny model" });
  await user.click(trigger);
  expect(screen.getByRole("menuitemradio", { name: "GPT 6.2 Astra" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await user.click(screen.getByRole("menuitemradio", { name: "Gemini 4 Neon" }));
  expect(onChange).toHaveBeenCalledWith("two");
  expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  expect(trigger).toHaveFocus();
});

it("keeps unavailable models visible and prevents selecting them", async () => {
  const user = userEvent.setup(),
    onChange = vi.fn();
  render(
    <BennyModelPicker
      value="one"
      options={[
        { value: "one", label: "GPT 6.2 Astra" },
        { value: "two", label: "Gemini 4 Carbon", disabled: true },
      ]}
      onChange={onChange}
    />,
  );
  await user.click(screen.getByRole("button", { name: "Benny model" }));
  const unavailable = screen.getByRole("menuitemradio", { name: "Gemini 4 Carbon" });
  expect(unavailable).toHaveAttribute("aria-disabled", "true");
  await user.click(unavailable);
  expect(onChange).not.toHaveBeenCalled();
});
