import { getExpertConfigurationService } from "../configuration/expert-configuration-runtime.js";
import { getExpertPromptStore } from "../configuration/expert-prompts.js";
import {
  assertExpertIntention,
  type ExpertIntention,
  type ExpertProviderName,
} from "../configuration/expert-definitions.js";
import type { LlmUsageMetrics } from "../llm/openai-compatible-provider.js";
import { createTextGenerator } from "../llm/provider-factory.js";
import type { BugReviewExpert } from "./bug-review-expert.js";
import { ConfigurableReviewExpert } from "./configurable-review-expert.js";
import { createReviewExpert } from "./review-expert-factory.js";
import type { ReviewExpert } from "./review-expert.js";

const PLACEHOLDER_API_KEY = "REMPLACER_PAR_VOTRE_CLE";

export class ReviewConfigurationError extends Error {
  constructor() {
    super("La configuration de l'expert de revue est indisponible.");
    this.name = "ReviewConfigurationError";
  }
}

export type ReviewExpertSelection = {
  expert: ReviewExpert;
  metadata: {
    installationId: number;
    intention: ExpertIntention;
    provider: ExpertProviderName;
    model: string;
    source: "installation" | "environment";
  };
};

function environmentGeminiCredentials(): {
  apiKey: string;
  model: string;
} | null {
  const apiKey = (
    process.env.GEMINI_REVIEW_API_KEY ?? process.env.GEMINI_API_KEY
  )?.trim();
  if (!apiKey || apiKey === PLACEHOLDER_API_KEY) return null;

  return {
    apiKey,
    model: process.env.GEMINI_REVIEW_MODEL?.trim() || "gemini-3.5-flash-lite",
  };
}

export async function resolveReviewExpert(
  installationId: number | undefined,
  intention: ExpertIntention,
  onUsage?: (metrics: LlmUsageMetrics) => void,
): Promise<ReviewExpertSelection | null> {
  // Une panne de lecture/chiffrement/construction ne doit jamais être traitée
  // comme une absence de configuration. Aucune erreur brute ne sort d'ici.
  try {
    if (
      installationId === undefined ||
      !Number.isSafeInteger(installationId) ||
      installationId <= 0
    ) {
      throw new ReviewConfigurationError();
    }
    assertExpertIntention(intention);
    const configuration = await getExpertConfigurationService().resolve(
      installationId,
      intention,
    );
    const customSystemPrompt =
      (await getExpertPromptStore()?.resolve(installationId, intention)) ??
      undefined;

    if (configuration) {
      if (
        configuration.installationId !== installationId ||
        configuration.intention !== intention
      ) {
        throw new ReviewConfigurationError();
      }
      return {
        expert:
          customSystemPrompt !== undefined
            ? createReviewExpert(configuration, onUsage, customSystemPrompt)
            : createReviewExpert(configuration, onUsage),
        metadata: {
          installationId,
          intention,
          provider: configuration.provider,
          model: configuration.model,
          source: "installation",
        },
      };
    }

    const credentials = environmentGeminiCredentials();
    if (!credentials) return null;

    return {
      expert:
        customSystemPrompt !== undefined
          ? new ConfigurableReviewExpert(
              createTextGenerator(
                { provider: "gemini", ...credentials },
                onUsage,
              ),
              customSystemPrompt,
            )
          : new ConfigurableReviewExpert(
              createTextGenerator(
                { provider: "gemini", ...credentials },
                onUsage,
              ),
            ),
      metadata: {
        installationId,
        intention,
        provider: "gemini",
        model: credentials.model,
        source: "environment",
      },
    };
  } catch {
    throw new ReviewConfigurationError();
  }
}

// Compatibilité des appels Bug : toute résolution passe par le même moteur.
export { ReviewConfigurationError as BugReviewConfigurationError };

export type BugReviewExpertSelection = {
  expert: BugReviewExpert;
  metadata: Omit<ReviewExpertSelection["metadata"], "intention"> & {
    intention: "bug";
  };
};

export async function resolveBugReviewExpert(
  installationId: number | undefined,
  onUsage?: (metrics: LlmUsageMetrics) => void,
): Promise<BugReviewExpertSelection | null> {
  const selection = await resolveReviewExpert(installationId, "bug", onUsage);
  if (!selection) return null;
  return {
    expert: {
      reviewBugFix: (context) => selection.expert.review(context, "bug"),
    },
    metadata: { ...selection.metadata, intention: "bug" },
  };
}
