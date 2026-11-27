import type { CodeReviewResult } from "../domain/code-review.js";
import type { PullRequestLlmContext } from "../domain/pull-request-data.js";
import type { TextGenerator } from "../llm/text-generator.js";
import { estimateTokens } from "../llm/patch-utils.js";
import { retryLlmRequest } from "../llm/retry.js";
import {
  LlmEmptyResponseError,
  LlmInvalidResponseError,
} from "../llm/provider-error.js";
import { getExpertPolicy } from "./expert-policies.js";
import type { ReviewExpert } from "./review-expert.js";
import { buildReviewPrompt, buildReviewSystemPrompt } from "./review-prompt.js";
import { REVIEW_SCHEMA, validateReviewResponse } from "./review-response.js";
import { parseReviewResult } from "./review-parser.js";

export class ConfigurableReviewExpert implements ReviewExpert {
  constructor(
    private readonly generator: TextGenerator,
    private readonly customSystemPrompt?: string,
  ) {}

  async review(
    context: PullRequestLlmContext,
    intent: string,
  ): Promise<CodeReviewResult> {
    const policy = getExpertPolicy(intent);
    if (!policy) {
      throw new LlmInvalidResponseError(
        "aucune politique de revue enregistrée",
      );
    }
    const system =
      this.customSystemPrompt?.trim() || buildReviewSystemPrompt(policy);
    const prompt = buildReviewPrompt(context, policy);
    // Inclure le schéma et une marge de protocole, sans modifier le contexte
    // sélectionné pour le classifieur ni tronquer silencieusement le diff.
    const estimatedTokens =
      estimateTokens(system) +
      estimateTokens(prompt) +
      estimateTokens(JSON.stringify(REVIEW_SCHEMA)) +
      128;
    if (estimatedTokens > this.generator.tokenBudget.promptTokenBudget) {
      throw new Error(
        "Le contexte de revue dépasse le budget du modèle de l’expert.",
      );
    }
    const content = await retryLlmRequest(() =>
      this.generator.generate({
        system,
        prompt,
        maxOutputTokens: this.generator.tokenBudget.responseReserveTokens,
        jsonSchema: REVIEW_SCHEMA,
      }),
    );
    if (!content.trim()) throw new LlmEmptyResponseError("L’expert de revue");
    validateReviewResponse(content);
    return parseReviewResult(content, context, policy.intent);
  }
}
