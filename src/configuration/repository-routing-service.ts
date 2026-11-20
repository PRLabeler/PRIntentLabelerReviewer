import type {
  ExpertRoutingScope,
  RepositoryRoutingPolicy,
} from "../domain/expert-routing.js";
import { DEFAULT_UNMAPPED_LABEL_BEHAVIOR } from "../domain/expert-routing.js";
import { isExpertIntention } from "./expert-definitions.js";
import {
  RepositoryRoutingUnavailableError,
  RepositoryRoutingSchemaMissingError,
  RepositoryRoutingValidationError,
  type ChangeRepositoryRoutingPolicyInput,
  type RepositoryRoutingRepository,
  type StoredRepositoryRoutingPolicy,
} from "./repository-routing.js";

function assertPositiveId(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RepositoryRoutingValidationError(
      "L’identifiant GitHub doit être un entier positif sûr.",
    );
  }
}

function validatePolicy(policy: RepositoryRoutingPolicy): void {
  assertPositiveId(policy.installationId);
  assertPositiveId(policy.repositoryId);
  if (
    !["none", "general"].includes(policy.defaultBehavior) ||
    !Array.isArray(policy.mappings)
  ) {
    throw new RepositoryRoutingValidationError(
      "La politique de routage est invalide.",
    );
  }
  const seenIds = new Set<number>();
  for (const mapping of policy.mappings) {
    assertPositiveId(mapping.labelId);
    if (seenIds.has(mapping.labelId)) {
      throw new RepositoryRoutingValidationError(
        "Un label ne peut avoir qu’une correspondance.",
      );
    }
    seenIds.add(mapping.labelId);
    if (mapping.target?.kind === "none") continue;
    if (
      mapping.target?.kind !== "expert" ||
      !isExpertIntention(mapping.target.expertId)
    ) {
      throw new RepositoryRoutingValidationError(
        "L’expert associé n’est pas pris en charge.",
      );
    }
  }
}

async function withStorageErrors<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    // Ne jamais exposer les détails SQL et ne jamais transformer une panne
    // en absence de politique autorisant le routage historique.
    if ((error as { code?: string } | null)?.code === "42P01") {
      throw new RepositoryRoutingSchemaMissingError();
    }
    throw new RepositoryRoutingUnavailableError();
  }
}

export class RepositoryRoutingService {
  constructor(private readonly repository: RepositoryRoutingRepository) {}

  async getPolicy(
    scope: ExpertRoutingScope,
  ): Promise<StoredRepositoryRoutingPolicy | null> {
    assertPositiveId(scope.installationId);
    assertPositiveId(scope.repositoryId);
    return withStorageErrors(async () => {
      const policy = await this.repository.findByRepository(scope);
      if (policy) {
        validatePolicy(policy);
        if (
          policy.installationId !== scope.installationId ||
          policy.repositoryId !== scope.repositoryId
        ) {
          throw new Error(
            "La politique retournée ne correspond pas au dépôt demandé.",
          );
        }
      }
      return policy;
    });
  }

  async save(
    input: ChangeRepositoryRoutingPolicyInput,
  ): Promise<StoredRepositoryRoutingPolicy> {
    validatePolicy(input);
    if (input.githubUserId !== undefined) assertPositiveId(input.githubUserId);
    if (input.catalog.repository.id !== input.repositoryId) {
      throw new RepositoryRoutingValidationError(
        "Le catalogue de labels ne correspond pas au dépôt.",
      );
    }
    const labels = new Map(
      input.catalog.labels.map((label) => [label.id, label]),
    );
    const previous = await this.getPolicy(input);
    const previousMappings = new Map(
      previous?.mappings.map((mapping) => [mapping.labelId, mapping]),
    );
    const completeMappings = new Map(
      input.mappings.map((mapping) => [mapping.labelId, mapping]),
    );
    // Une omission ne supprime pas un choix enregistré, notamment Aucun.
    // Les règles des labels supprimés restent inactives et sont conservées.
    for (const mapping of previous?.mappings ?? []) {
      if (!completeMappings.has(mapping.labelId)) {
        completeMappings.set(mapping.labelId, mapping);
      }
    }
    for (const label of input.catalog.labels) {
      if (!completeMappings.has(label.id)) {
        completeMappings.set(label.id, {
          labelId: label.id,
          target: { kind: "expert", expertId: "general" },
        });
      }
    }
    const mappings = [...completeMappings.values()].map((mapping) => {
      const label = labels.get(mapping.labelId);
      // Une règle orpheline déjà enregistrée peut être conservée. Un nouvel
      // identifiant inconnu du catalogue ne peut pas être associé par son nom.
      const labelName =
        label?.name ?? previousMappings.get(mapping.labelId)?.labelName;
      if (typeof labelName !== "string" || !labelName.trim()) {
        throw new RepositoryRoutingValidationError(
          "Ce label n’est pas présent dans le dépôt ni dans la politique enregistrée.",
        );
      }
      return { ...mapping, labelName };
    });

    return withStorageErrors(() =>
      this.repository.upsert({
        installationId: input.installationId,
        repositoryId: input.repositoryId,
        defaultBehavior: DEFAULT_UNMAPPED_LABEL_BEHAVIOR,
        mappings,
        githubUserId: input.githubUserId,
      }),
    );
  }

  async deleteForInstallation(
    installationId: number,
    githubUserId?: number,
  ): Promise<number> {
    assertPositiveId(installationId);
    if (githubUserId !== undefined) assertPositiveId(githubUserId);
    return withStorageErrors(() =>
      this.repository.deleteForInstallation(installationId, githubUserId),
    );
  }
}
