import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { ProactiveMessageFeedback } from "./ProactiveMessageFeedback";
const payload = {
  action: "answer",
  message: "A practical weekly review.",
  cards: [],
  proactive: {
    signalId: "signal",
    signalKey: "key",
    whyNow: "A recent example informs your next post.",
    feedback: null,
    feedbackActions: ["useful", "not_relevant", "less_like_this"],
    topicKeys: ["subject:creator burnout"],
    draftBindings: [],
  },
};
it("renders rationale and real feedback actions, preserving persisted feedback", async () => {
  const feedback = vi.fn().mockResolvedValue(undefined);
  const { rerender } = render(<ProactiveMessageFeedback payload={payload} onFeedback={feedback} />);
  expect(screen.getByText(/A recent example/)).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Not relevant" }));
  expect(feedback).toHaveBeenCalledWith("not_relevant");
  rerender(
    <ProactiveMessageFeedback
      payload={{ ...payload, proactive: { ...payload.proactive, feedback: "not_relevant" } }}
      onFeedback={feedback}
    />,
  );
  expect(screen.getByRole("button", { name: "Not relevant" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  expect(screen.getByText(/avoid this source/)).toBeInTheDocument();
});
it("reports failed feedback and leaves a retry action", async () => {
  render(
    <ProactiveMessageFeedback
      payload={payload}
      onFeedback={vi.fn().mockRejectedValue(new Error("offline"))}
    />,
  );
  await userEvent.click(screen.getByRole("button", { name: "Useful" }));
  expect(screen.getByRole("alert")).toHaveTextContent("could not be saved");
  expect(screen.getByRole("button", { name: "Useful" })).toBeEnabled();
});
it("ordinary messages have no proactive footer", () => {
  const { container } = render(
    <ProactiveMessageFeedback
      payload={{ action: "answer", message: "Hello", cards: [] }}
      onFeedback={vi.fn()}
    />,
  );
  expect(container).toBeEmptyDOMElement();
});

it("saves Less like this as a distinct durable topic preference", async () => {
  const feedback = vi.fn().mockResolvedValue(undefined);
  const { rerender } = render(<ProactiveMessageFeedback payload={payload} onFeedback={feedback} />);
  await userEvent.click(screen.getByRole("button", { name: "Less like this" }));
  expect(feedback).toHaveBeenCalledWith("less_like_this");
  rerender(
    <ProactiveMessageFeedback
      payload={{ ...payload, proactive: { ...payload.proactive, feedback: "less_like_this" } }}
      onFeedback={feedback}
    />,
  );
  expect(screen.getByRole("button", { name: "Less like this" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  expect(screen.getByText(/less about this topic/)).toBeInTheDocument();
});
