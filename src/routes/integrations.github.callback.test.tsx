import { expect, it } from "vitest";
import { Route } from "./integrations.github.callback";

it("accepts the numeric installation ID parsed from GitHub's callback URL", () => {
  const schema = Route.options.validateSearch as {
    parse: (value: unknown) => { installation_id?: string };
  };
  expect(schema.parse({ installation_id: 170708985 }).installation_id).toBe("170708985");
});
