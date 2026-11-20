import type { ResolvedExpertConfiguration } from "../configuration/expert-configuration.js";
import { assertExpertProvider } from "../configuration/expert-definitions.js";
import { createTextGenerator } from "../llm/provider-factory.js";
import type { LlmUsageMetrics } from "../llm/openai-compatible-provider.js";
import { ConfigurableReviewExpert } from "./configurable-review-expert.js";
import type { ReviewExpert } from "./review-expert.js";

export function createReviewExpert(
  configuration: ResolvedExpertConfiguration,
  onUsage?: (metrics: LlmUsageMetrics) => void,
): ReviewExpert {
  assertExpertProvider(configuration.intention, configuration.provider);
  return new ConfigurableReviewExpert(
    createTextGenerator(configuration, onUsage),
  );
}
