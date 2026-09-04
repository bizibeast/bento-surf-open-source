import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { sanitizeCustomerLibraryReturnTo } from "./customer-library-auth.server";

const source = (name: string) => readFileSync(resolve(process.cwd(), "src/lib", name), "utf8");

describe("customer library authentication", () => {
  it("keeps email imports away from cookie-backed customer sessions", () => {
    const email = source("email.server.ts");
    const customerLibrary = source("customer-library.functions.ts");
    const helperPath = resolve(process.cwd(), "src/lib/customer-library-magic-link.server.ts");

    expect(email).not.toContain('from "./customer-library-auth.server"');
    expect(email).toContain('from "./customer-library-magic-link.server"');
    expect(customerLibrary).toContain('from "./customer-library-magic-link.server"');
    expect(existsSync(helperPath)).toBe(true);
    if (!existsSync(helperPath)) return;
    expect(readFileSync(helperPath, "utf8")).not.toContain("@tanstack/react-start/server");
  });

  it("allows only the library and canonical Priority DM conversation paths", () => {
    expect(sanitizeCustomerLibraryReturnTo("/library")).toBe("/library");
    expect(
      sanitizeCustomerLibraryReturnTo("/library/priority-dm/11111111-1111-4111-8111-111111111111"),
    ).toBe("/library/priority-dm/11111111-1111-4111-8111-111111111111");

    for (const unsafe of [
      "https://evil.test",
      "//evil.test",
      "/\\evil.test",
      "/store",
      "/library/priority-dm/nope",
      "/library/priority-dm/11111111-1111-4111-8111-111111111111?source=email",
      "/library/priority-dm/11111111-1111-4111-8111-111111111111#reply",
      "/library/priority-dm%2F11111111-1111-4111-8111-111111111111",
    ]) {
      expect(sanitizeCustomerLibraryReturnTo(unsafe)).toBe("/library");
    }
  });
});
