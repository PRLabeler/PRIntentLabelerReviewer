import type { LlmProviderName } from "../llm/provider-configuration.js";
import {
  getExpertPolicy,
  registeredIntents,
} from "../review/expert-policies.js";

export const EXPERT_PROVIDER_NAMES = [
  "anthropic",
  "openai",
  "gemini",
] as const satisfies readonly LlmProviderName[];

export type ExpertProviderName = (typeof EXPERT_PROVIDER_NAMES)[number];

// Le registre des politiques est la source des catégories configurables.
// Aucune liste d'intentions supplémentaire n'est à maintenir ici.
export const EXPERT_DEFINITIONS = Object.fromEntries(
  registeredIntents().map((intention) => [
    intention,
    {
      displayName:
        getExpertPolicy(intention)?.displayName ??
        intention.charAt(0).toUpperCase() + intention.slice(1),
      providers: EXPERT_PROVIDER_NAMES,
    },
  ]),
);

export type ExpertIntention = keyof typeof EXPERT_DEFINITIONS;

export function isExpertIntention(value: unknown): value is ExpertIntention {
  return typeof value === "string" && Object.hasOwn(EXPERT_DEFINITIONS, value);
}

export function isExpertProviderName(
  value: unknown,
): value is ExpertProviderName {
  return (
    typeof value === "string" &&
    EXPERT_PROVIDER_NAMES.includes(value as ExpertProviderName)
  );
}

export function assertExpertIntention(
  value: unknown,
): asserts value is ExpertIntention {
  if (!isExpertIntention(value)) {
    throw new Error("Cette intention n’est pas configurable.");
  }
}

export function assertExpertProvider(
  intention: ExpertIntention,
  provider: unknown,
): asserts provider is ExpertProviderName {
  assertExpertIntention(intention);
  if (
    !isExpertProviderName(provider) ||
    !(EXPERT_DEFINITIONS[intention].providers as readonly string[]).includes(
      provider,
    )
  ) {
    throw new Error("Ce fournisseur n’est pas autorisé pour cet expert.");
  }
}
