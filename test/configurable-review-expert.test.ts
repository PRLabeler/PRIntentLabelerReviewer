import { afterEach, describe, expect, it, vi } from "vitest";
import { EXPERT_PROVIDER_NAMES } from "../src/configuration/expert-definitions.js";
import { ConfigurableReviewExpert } from "../src/review/configurable-review-expert.js";
import { createReviewExpert } from "../src/review/review-expert-factory.js";
import {
  getExpertPolicy,
  registeredIntents,
} from "../src/review/expert-policies.js";
import {
  buildReviewPrompt,
  buildReviewSystemPrompt,
} from "../src/review/review-prompt.js";
import { defaultLlmTokenBudget } from "../src/llm/model-budget.js";
import {
  finding,
  providerResponse,
  reviewContext,
  reviewText,
} from "./fixtures/bug-review.js";

afterEach(() => vi.unstubAllGlobals());

describe("experts configurables par intention", () => {
  it.each(
    registeredIntents().flatMap((intention) =>
      EXPERT_PROVIDER_NAMES.map((provider) => ({ intention, provider })),
    ),
  )(
    "applique la politique $intention avec $provider",
    async ({ intention, provider }) => {
      const fetchMock = vi.fn(async () =>
        providerResponse(provider, reviewText),
      );
      vi.stubGlobal("fetch", fetchMock);
      const expert = createReviewExpert({
        installationId: 42,
        intention,
        provider,
        model: "configured-review-model",
        apiKey: "fake-review-key",
      });
      const context = reviewContext();
      const before = structuredClone(context);

      expect(await expert.review(context, intention)).toEqual({
        intent: intention,
        verdict: "changes-requested",
        summary: "Une correction est nécessaire.",
        findings: [finding],
      });
      expect(context).toEqual(before);
      expect(fetchMock).toHaveBeenCalledOnce();
      const [, request] = fetchMock.mock.calls[0] as unknown as [
        string,
        RequestInit,
      ];
      const body = JSON.parse(request.body as string);
      const policy = getExpertPolicy(intention)!;
      let system: string;
      let prompt: string;
      if (provider === "gemini") {
        system = body.systemInstruction.parts[0].text;
        prompt = body.contents[0].parts[0].text;
      } else if (provider === "anthropic") {
        system = body.system;
        prompt = body.messages[0].content;
      } else {
        system = body.messages[0].content;
        prompt = body.messages[1].content;
      }
      expect(system).toBe(buildReviewSystemPrompt(policy));
      expect(prompt).toBe(buildReviewPrompt(context, policy));
    },
  );

  it.each(registeredIntents())(
    "contrôle le budget de %s avant toute requête",
    async (intention) => {
      const generator = {
        tokenBudget: { ...defaultLlmTokenBudget(), promptTokenBudget: 1 },
        generate: vi.fn(),
      };
      const expert = new ConfigurableReviewExpert(generator);
      const context = reviewContext();
      const before = structuredClone(context);
      await expect(expert.review(context, intention)).rejects.toThrow(
        "dépasse le budget",
      );
      expect(generator.generate).not.toHaveBeenCalled();
      expect(context).toEqual(before);
    },
  );

  it.each([
    "",
    "invalid JSON",
    '{"summary":"Classification","suggestions":[]}',
    '{"summary":"","findings":[]}',
    '{"summary":"Revue","findings":null}',
  ])(
    "rejette une enveloppe invalide pour un expert non Bug : %s",
    async (content) => {
      const generator = {
        tokenBudget: defaultLlmTokenBudget(),
        generate: vi.fn().mockResolvedValue(content),
      };
      await expect(
        new ConfigurableReviewExpert(generator).review(
          reviewContext(),
          "security",
        ),
      ).rejects.toThrow();
      expect(generator.generate).toHaveBeenCalledOnce();
    },
  );

  it("rejette une intention inconnue avant toute génération", async () => {
    const generator = {
      tokenBudget: defaultLlmTokenBudget(),
      generate: vi.fn(),
    };
    await expect(
      new ConfigurableReviewExpert(generator).review(
        reviewContext(),
        "unknown-expert",
      ),
    ).rejects.toThrow();
    expect(generator.generate).not.toHaveBeenCalled();
  });
});
