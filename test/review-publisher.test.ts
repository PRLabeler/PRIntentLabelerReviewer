import { afterEach, describe, expect, it, vi } from "vitest";
import type { CodeReviewResult } from "../src/domain/code-review.js";
import type { PullRequestData } from "../src/domain/pull-request-data.js";
import { publishIntentReview } from "../src/github/review-publisher.js";

const prData = {
  owner: "org",
  repo: "repo",
  number: 4,
  headSha: "abc123",
} as PullRequestData;

const review: CodeReviewResult = {
  intent: "bug",
  verdict: "changes-requested",
  summary: "Le calcul reste incorrect.",
  findings: [
    {
      file: "src/cart-total.ts",
      startLine: 19,
      endLine: 19,
      severity: "error",
      message: "Le total peut encore être négatif.",
      suggestion: "Borner le résultat final avec Math.max.",
    },
  ],
};

function createContext(existing: unknown[] = []) {
  return {
    octokit: {
      pulls: {
        listReviewComments: vi.fn().mockResolvedValue({ data: existing }),
        createReview: vi.fn().mockResolvedValue({}),
      },
    },
    log: { info: vi.fn() },
  };
}

afterEach(() => {
  delete process.env.APP_ID;
});

describe("publishIntentReview", () => {
  it.each(["bug", "general"])(
    "publie la revue %s avec un commentaire inline",
    async (intent) => {
      const context = createContext();

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await publishIntentReview(context as any, prData, { ...review, intent });

      expect(context.octokit.pulls.createReview).toHaveBeenCalledWith(
        expect.objectContaining({
          event: "REQUEST_CHANGES",
          commit_id: "abc123",
          body: expect.stringContaining(`Revue spécialisée — ${intent}`),
          comments: [
            expect.objectContaining({
              path: "src/cart-total.ts",
              line: 19,
              side: "RIGHT",
              body: expect.stringContaining("**Solution proposée :**"),
            }),
          ],
        }),
      );
    },
  );

  it.each(["bug", "general"])(
    "ne republie pas la revue %s pour le même SHA",
    async (intent) => {
      process.env.APP_ID = "42";
      const context = createContext([
        {
          body: `<!-- llm-pr-intent-review intent=${intent} sha=abc123 -->\nDéjà publié`,
          user: { type: "Bot" },
          performed_via_github_app: { id: 42 },
        },
      ]);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await publishIntentReview(context as any, prData, { ...review, intent });

      expect(context.octokit.pulls.createReview).not.toHaveBeenCalled();
    },
  );
});
