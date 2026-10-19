import { expect, it } from "vitest";
import { serverSha256 } from "./server-sha256.server";

it("preserves SHA-256 fingerprints and byte rotation inputs", () => {
  const digest = serverSha256("abc");
  expect(digest.toString("hex")).toBe(
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
  expect(digest[0]).toBe(186);
});
