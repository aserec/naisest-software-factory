import { expect, test } from "vitest";
import { findSecrets } from "./rules";

test("finds a GitLab token and a private key header", () => {
  expect(findSecrets("x glpat-abcdefghijklmnopqrst y")).toEqual(["glpat-abcdefghijklmnopqrst"]);
  expect(findSecrets("-----BEGIN RSA PRIVATE KEY-----")).toHaveLength(1);
  expect(findSecrets("-----BEGIN PRIVATE KEY-----")).toHaveLength(1);
});
test("plain text has no secrets", () => {
  expect(findSecrets("glpat-short and normal words")).toEqual([]);
});
