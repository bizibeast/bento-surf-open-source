import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { InstagramPublicRepliesEditor } from "./InstagramPublicRepliesEditor";

afterEach(cleanup);

function Editor() {
  const [replies, setReplies] = useState(["Thanks, check your inbox!"]);
  return <InstagramPublicRepliesEditor value={replies} onChange={setReplies} />;
}

it("applies a comma/newline list as separate editable replies without damaging punctuation", () => {
  render(<Editor />);
  expect(screen.getByLabelText("Public reply 1")).toHaveValue("Thanks, check your inbox!");
  fireEvent.click(screen.getByText("Paste comma-separated replies"));
  fireEvent.change(screen.getByLabelText("Reply list"), {
    target: { value: " Check your DMs,\r\n Sent the guide , On its way, " },
  });
  fireEvent.click(screen.getByRole("button", { name: "Apply reply list" }));
  expect(screen.getByLabelText("Public reply 1")).toHaveValue("Check your DMs");
  expect(screen.getByLabelText("Public reply 2")).toHaveValue("Sent the guide");
  expect(screen.getByLabelText("Public reply 3")).toHaveValue("On its way");
  fireEvent.change(screen.getByLabelText("Public reply 2"), {
    target: { value: "Done, check your DMs!" },
  });
  expect(screen.getByLabelText("Public reply 2")).toHaveValue("Done, check your DMs!");
  expect(screen.getByLabelText("Public reply 3")).toHaveValue("On its way");
});

it.each(["one,two,three,four", ", \n ,", "a".repeat(301)])(
  "rejects an invalid reply list without replacing saved replies: %s",
  (value) => {
    render(<Editor />);
    fireEvent.click(screen.getByText("Paste comma-separated replies"));
    fireEvent.change(screen.getByLabelText("Reply list"), { target: { value } });
    fireEvent.click(screen.getByRole("button", { name: "Apply reply list" }));
    expect(screen.getByRole("alert")).toBeVisible();
    expect(screen.getByLabelText("Public reply 1")).toHaveValue("Thanks, check your inbox!");
  },
);
