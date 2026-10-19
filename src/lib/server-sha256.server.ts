import { createHash } from "node:crypto";
import { createServerOnlyFn } from "@tanstack/react-start";

/** Keep Node crypto out of browser imports of shared server-function modules. */
export const serverSha256 = createServerOnlyFn((value: string) =>
  createHash("sha256").update(value).digest(),
);
