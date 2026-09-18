import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { ProductWebsiteEditor } from "./ProductWebsiteEditor";
import { productWebsite } from "@/lib/product-website";
it("lets creators customize branding and add, reorder, and remove page sections", () => {
  function Preview() {
    const [value, setValue] = useState(productWebsite({}));
    return (
      <ProductWebsiteEditor
        value={value}
        onChange={setValue}
        title="Field Notes"
        subtitle="A practical guide"
      />
    );
  }
  render(<Preview />);
  fireEvent.change(screen.getByLabelText("Brand name"), { target: { value: "Field Studio" } });
  expect(screen.getByLabelText("Website preview")).toHaveTextContent("Field Studio");
  fireEvent.click(screen.getByRole("button", { name: "Add section" }));
  fireEvent.change(screen.getByLabelText("Heading"), { target: { value: "Outcomes" } });
  fireEvent.click(screen.getByRole("button", { name: "Add section" }));
  fireEvent.change(screen.getAllByLabelText("Heading")[1], { target: { value: "Questions" } });
  fireEvent.click(screen.getByRole("button", { name: "Move section 2 up" }));
  expect(screen.getAllByLabelText("Heading")[0]).toHaveValue("Questions");
  fireEvent.click(screen.getAllByRole("button", { name: "Remove" })[0]);
  expect(screen.getByLabelText("Heading")).toHaveValue("Outcomes");
});
