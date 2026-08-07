import { describe, expect, it } from "vitest";
import { resolveSharingDomain } from "../src/sharing-domain.js";

describe("resolveSharingDomain", () => {
  it("prefers service-binding props when the deployment supports them", () => {
    expect(resolveSharingDomain("binding", "environment")).toBe("binding");
  });

  it("falls back to the Worker environment", () => {
    expect(resolveSharingDomain(undefined, "environment")).toBe("environment");
  });

  it("uses the package default when neither deployment input is present", () => {
    expect(resolveSharingDomain(undefined, undefined)).toBe("default");
  });
});
