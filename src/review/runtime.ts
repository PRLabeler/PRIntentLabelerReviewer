import { getExpertConfigurationService } from "../configuration/expert-configuration-runtime.js";
import type { ExpertProviderName } from "../configuration/expert-definitions.js";
import type { LlmUsageMetrics } from "../llm/openai-compatible-provider.js";
import { createTextGenerator } from "../llm/provider-factory.js";
import type { BugReviewExpert } from "./bug-review-expert.js";
import { createBugReviewExpert } from "./bug-review-expert-factory.js";
import { ConfigurableBugReviewExpert } from "./configurable-bug-review-expert.js";
import { GeminiReviewExpert } from "./gemini-review-expert.js";
import type { ReviewExpert } from "./review-expert.js";

const PLACEHOLDER_API_KEY = "REMPLACER_PAR_VOTRE_CLE";

export class BugReviewConfigurationError extends Error {
  constructor() {
    super("La configuration de l'expert bug est indisponible.");
    this.name = "BugReviewConfigurationError";
  }
}

export type BugReviewExpertSelection = {
  expert: BugReviewExpert;
  metadata: {
    installationId: number;
    intention: "bug";
    provider: ExpertProviderName;
    model: string;
    source: "installation" | "environment";
  };
};

function environmentGeminiCredentials(): { apiKey: string; model: string } | null {
  const apiKey = (
    process.env.GEMINI_REVIEW_API_KEY ?? process.env.GEMINI_API_KEY
  )?.trim();
  if (!apiKey || apiKey === PLACEHOLDER_API_KEY) return null;

  return {
    apiKey,
    model: process.env.GEMINI_REVIEW_MODEL?.trim() || "gemini-3.5-flash-lite",
  };
}

function assertInstallationId(
  installationId: unknown,
): asserts installationId is number {
  if (
    typeof installationId !== "number" ||
    !Number.isSafeInteger(installationId) ||
    installationId <= 0
  ) {
    throw new BugReviewConfigurationError();
  }
}

export function createEnvironmentReviewExpert(): ReviewExpert | null {
  const credentials = environmentGeminiCredentials();
  if (!credentials) return null;

  return new GeminiReviewExpert(credentials.apiKey, credentials.model);
}

export async function resolveBugReviewExpert(
  installationId: number,
  onUsage?: (metrics: LlmUsageMetrics) => void,
): Promise<BugReviewExpertSelection | null> {
  assertInstallationId(installationId);

  let configuration;
  try {
    configuration = await getExpertConfigurationService().resolve(
      installationId,
      "bug",
    );
  } catch {
    throw new BugReviewConfigurationError();
  }

  if (configuration) {
    let expert: BugReviewExpert;
    try {
      expert = createBugReviewExpert(configuration, onUsage);
    } catch {
      throw new BugReviewConfigurationError();
    }

    return {
      expert,
      metadata: {
        installationId,
        intention: "bug",
        provider: configuration.provider,
        model: configuration.model,
        source: "installation",
      },
    };
  }

  const credentials = environmentGeminiCredentials();
  if (!credentials) return null;

  return {
    expert: new ConfigurableBugReviewExpert(
      createTextGenerator(
        {
          provider: "gemini",
          apiKey: credentials.apiKey,
          model: credentials.model,
        },
        onUsage,
      ),
    ),
    metadata: {
      installationId,
      intention: "bug",
      provider: "gemini",
      model: credentials.model,
      source: "environment",
    },
  };
}
