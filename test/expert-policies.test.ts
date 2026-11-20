import { describe, expect, it } from "vitest";
import { getExpertPolicy } from "../src/review/expert-policies.js";
import {
  buildReviewPrompt,
  buildReviewSystemPrompt,
} from "../src/review/review-prompt.js";
import { reviewContext } from "./fixtures/bug-review.js";

describe("expert policies", () => {
  it("définit une revue générale étayée par le diff, sans présumer une intention", () => {
    const policy = getExpertPolicy("general")!;
    expect(policy.displayName).toBe("Général");
    const system = buildReviewSystemPrompt(policy);
    expect(system).toContain("logic errors");
    expect(system).toContain("unintended behaviour regressions");
    expect(system).toContain("unhandled edge cases");
    expect(system).toContain("concrete security defects");
    expect(system).toContain("demonstrable reliability defects");
    expect(system).toContain("Do not report style preferences");
    const prompt = buildReviewPrompt(reviewContext(), policy);
    expect(prompt).toContain("using a general code-review policy");
    expect(prompt).not.toContain("already classified as");
  });
  it("enregistre les experts feature et refactor", () => {
    expect(getExpertPolicy("feature")?.roleTitle).toContain("feature");
    expect(getExpertPolicy("refactor")?.reviewPolicy).toContain(
      "preserves observable behaviour",
    );
  });

  it("enregistre les experts documentation et tests", () => {
    expect(getExpertPolicy("documentation")?.classifiedAs).toContain(
      "documentation",
    );
    expect(getExpertPolicy("tests")?.reviewPolicy).toContain("assertions");
  });

  it("enregistre les experts ci-cd et dependencies", () => {
    expect(getExpertPolicy("ci-cd")?.roleTitle).toContain("CI/CD");
    expect(getExpertPolicy("dependencies")?.reviewPolicy).toContain("lockfile");
  });

  it("enregistre les experts performance, security et breaking-change", () => {
    expect(getExpertPolicy("performance")?.classifiedAs).toContain(
      "performance",
    );
    expect(getExpertPolicy("security")?.reviewPolicy).toContain(
      "authentication",
    );
    expect(getExpertPolicy("breaking-change")?.roleTitle).toContain(
      "breaking-change",
    );
  });
});
