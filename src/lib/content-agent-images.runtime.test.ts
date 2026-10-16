import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { transpile } from "typescript";
import { expect, it } from "vitest";
it("hydrates API Mart Worker secrets and compact content flags before runtime consumers", () => {
  const source = readFileSync("src/server.ts", "utf8");
  const actualHydrator = source.slice(
    source.indexOf("const RUNTIME_STRING_BINDING_PREFIXES"),
    source.indexOf("function isPrivateApplicationPath"),
  );
  const sandbox = {
    process: { env: {} as Record<string, string> },
    bindings: {
      APIMART_API_KEY: "synthetic-test-value",
      RUNTIME_CONFIG: { CONTENT_AGENT_IMAGES_ENABLED: "false" },
      UNAPPROVED_KEY: "not-copied",
    },
  };
  runInNewContext(transpile(actualHydrator) + "\nhydrateRuntimeEnv(bindings)", sandbox);
  expect(sandbox.process.env.APIMART_API_KEY).toBe("synthetic-test-value");
  expect(sandbox.process.env.CONTENT_AGENT_IMAGES_ENABLED).toBe("false");
  expect(sandbox.process.env.UNAPPROVED_KEY).toBeUndefined();
  expect(readFileSync(".env.example", "utf8")).not.toMatch(/VITE_APIMART/);
});
