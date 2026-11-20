import type {
  ExpertRoutingCandidate,
  ExpertRoutingInput,
  ExpertRoutingPlan,
  ExpertRoutingTrigger,
  LabelExpertMapping,
  RepositoryRoutingPolicy,
} from "../domain/expert-routing.js";

export class InvalidExpertRoutingPolicyError extends Error {
  constructor() {
    super("La politique de routage des experts est invalide.");
    this.name = "InvalidExpertRoutingPolicyError";
  }
}

function assertPositiveId(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new InvalidExpertRoutingPolicyError();
  }
}

function validatePolicy(
  input: ExpertRoutingInput,
  policy: RepositoryRoutingPolicy,
  availableExperts: ReadonlySet<string>,
): void {
  if (
    !policy ||
    policy.installationId !== input.scope.installationId ||
    policy.repositoryId !== input.scope.repositoryId ||
    !["none", "general"].includes(policy.defaultBehavior) ||
    !Array.isArray(policy.mappings)
  ) {
    throw new InvalidExpertRoutingPolicyError();
  }

  if (!availableExperts.has("general")) {
    throw new InvalidExpertRoutingPolicyError();
  }

  const seenLabelIds = new Set<number>();
  for (const mapping of policy.mappings) {
    assertPositiveId(mapping.labelId);
    if (seenLabelIds.has(mapping.labelId)) {
      throw new InvalidExpertRoutingPolicyError();
    }
    seenLabelIds.add(mapping.labelId);

    if (mapping.target.kind === "none") continue;
    if (
      mapping.target.kind !== "expert" ||
      !availableExperts.has(mapping.target.expertId)
    ) {
      throw new InvalidExpertRoutingPolicyError();
    }
  }
}

function addTrigger(
  candidates: Map<string, ExpertRoutingCandidate>,
  expertId: string,
  trigger: ExpertRoutingTrigger,
): void {
  const current = candidates.get(expertId);
  if (!current) {
    candidates.set(expertId, {
      expertId,
      confidence: trigger.confidence,
      source: trigger.source,
      triggeringLabels: [trigger],
    });
    return;
  }

  let source = current.source;
  let confidence = current.confidence;
  if (trigger.source === current.source) {
    confidence = Math.max(confidence, trigger.confidence);
  } else if (trigger.source === "explicit") {
    source = trigger.source;
    confidence = trigger.confidence;
  }

  candidates.set(expertId, {
    expertId,
    confidence,
    source,
    triggeringLabels: [...current.triggeringLabels, trigger],
  });
}

function compareCandidates(
  first: ExpertRoutingCandidate,
  second: ExpertRoutingCandidate,
): number {
  if (first.source !== second.source) {
    if (first.source === "explicit") return -1;
    if (second.source === "explicit") return 1;
  }
  if (first.confidence !== second.confidence) {
    return second.confidence - first.confidence;
  }
  // Comparaison indépendante de la locale et de l'ordre reçu du LLM.
  if (first.expertId < second.expertId) return -1;
  if (first.expertId > second.expertId) return 1;
  return 0;
}

/**
 * Résolution sans accès réseau, base de données, appel LLM ou mutation.
 * Les seuils et le plafond des suggestions restent ceux du classifieur.
 */
export function buildExpertRoutingPlan(
  input: ExpertRoutingInput,
): ExpertRoutingPlan {
  assertPositiveId(input.scope.installationId);
  assertPositiveId(input.scope.repositoryId);

  const availableExperts = new Set(input.availableExpertIds);
  const policy = input.policy;
  const legacy = policy === null;
  if (policy !== null) {
    validatePolicy(input, policy, availableExperts);
  }

  const labelsByName = new Map(
    input.repositoryLabels.map((label) => [label.name.toLowerCase(), label]),
  );
  const mappingsByLabelId = new Map<number, LabelExpertMapping>();
  if (policy) {
    for (const mapping of policy.mappings) {
      mappingsByLabelId.set(mapping.labelId, mapping);
    }
  }

  const candidates = new Map<string, ExpertRoutingCandidate>();
  for (const suggestion of input.suggestions) {
    const label = labelsByName.get(suggestion.name.toLowerCase());
    if (legacy) {
      const expertId = suggestion.name.toLowerCase();
      if (!availableExperts.has(expertId)) continue;
      addTrigger(candidates, expertId, {
        ...suggestion,
        labelId: label?.id ?? null,
        source: "legacy",
      });
      continue;
    }

    // Sans label courant, une ancienne association ne doit pas s'appliquer,
    // même si un label supprimé a été recréé avec le même nom.
    if (!label) continue;
    const mapping = mappingsByLabelId.get(label.id);
    if (mapping) {
      if (mapping.target.kind === "none") continue;
      addTrigger(candidates, mapping.target.expertId, {
        ...suggestion,
        labelId: label.id,
        source: "explicit",
      });
    } else {
      addTrigger(candidates, "general", {
        ...suggestion,
        labelId: label.id,
        source: "default",
      });
    }
  }

  const orderedCandidates = [...candidates.values()];
  // Le mode historique garde exactement l'ordre des suggestions déjà validées,
  // y compris pour les égalités. Une politique enregistrée utilise les règles
  // déterministes du nouveau routage, même si elle est vide.
  if (!legacy) orderedCandidates.sort(compareCandidates);

  return {
    mode: legacy ? "legacy" : "configured",
    candidates: orderedCandidates,
    selectedExpert: orderedCandidates[0] ?? null,
  };
}
