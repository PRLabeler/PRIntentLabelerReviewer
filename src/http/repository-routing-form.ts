import { isExpertIntention } from "../configuration/expert-definitions.js";
import type { StoredRepositoryRoutingPolicy } from "../configuration/repository-routing.js";
import {
  DEFAULT_UNMAPPED_LABEL_BEHAVIOR,
  type ExpertRoutingScope,
  type LabelExpertMapping,
  type RepositoryRoutingPolicy,
} from "../domain/expert-routing.js";
import type { GitHubRepositoryLabelCatalog } from "../domain/github-repository.js";
import { parsePositiveInteger } from "./configuration-request.js";

export class RoutingFormError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 409 = 400,
  ) {
    super(message);
    this.name = "RoutingFormError";
  }
}

export type RoutingLabelRow = {
  labelId: number;
  name: string;
  description: string | null;
  missing: boolean;
  selection: string;
  proposed: boolean;
  savedSelection?: string;
};

function mappingSelection(mapping?: LabelExpertMapping): string {
  if (!mapping) return "expert:general";
  if (mapping.target.kind === "none") return "none";
  return `expert:${mapping.target.expertId}`;
}

export function routingPolicyVersion(
  policy: StoredRepositoryRoutingPolicy | null,
): string {
  return policy?.updatedAt.toISOString() ?? "absent";
}

export function buildRoutingLabelRows(
  catalog: GitHubRepositoryLabelCatalog,
  policy: StoredRepositoryRoutingPolicy | null,
  draft?: RepositoryRoutingPolicy,
): RoutingLabelRow[] {
  const savedMappings = new Map(
    policy?.mappings.map((mapping) => [mapping.labelId, mapping]),
  );
  const selections = new Map(
    (draft ?? policy)?.mappings.map((mapping) => [mapping.labelId, mapping]),
  );
  const rows: RoutingLabelRow[] = catalog.labels.map((label) => ({
    labelId: label.id,
    name: label.name,
    description: label.description,
    missing: false,
    selection: mappingSelection(selections.get(label.id)),
    proposed: false,
  }));
  const currentIds = new Set(catalog.labels.map((label) => label.id));
  for (const mapping of policy?.mappings ?? []) {
    if (!currentIds.has(mapping.labelId)) {
      rows.push({
        labelId: mapping.labelId,
        name: mapping.labelName,
        description: null,
        missing: true,
        selection: mappingSelection(selections.get(mapping.labelId)),
        proposed: false,
      });
    }
  }
  for (const row of rows) {
    const savedMapping = savedMappings.get(row.labelId);
    if (savedMapping) {
      row.savedSelection = mappingSelection(savedMapping);
    }
    row.proposed = !savedMapping;
  }
  return rows;
}

/** Les champs d'installation/dépôt du corps ne définissent jamais la portée. */
export function parseRoutingForm(
  body: Record<string, unknown>,
  scope: ExpertRoutingScope,
  catalog: GitHubRepositoryLabelCatalog,
  policy: StoredRepositoryRoutingPolicy | null,
): RepositoryRoutingPolicy {
  if (body.policyVersion !== routingPolicyVersion(policy)) {
    throw new RoutingFormError(
      "La configuration a changé depuis l’ouverture du formulaire. Les valeurs actuelles sont affichées ; vérifiez-les avant d’enregistrer à nouveau.",
      409,
    );
  }
  if (typeof body.labelIds !== "string")
    throw new RoutingFormError(
      "Le formulaire est incomplet. Rechargez la page.",
    );
  const ids = body.labelIds ? body.labelIds.split(",") : [];
  const fields = Object.keys(body).filter((name) => name.startsWith("label_"));
  if (fields.length !== ids.length || new Set(ids).size !== ids.length) {
    throw new RoutingFormError(
      "Le formulaire contient des correspondances manquantes ou dupliquées.",
    );
  }
  const knownIds = new Set([
    ...catalog.labels.map((label) => label.id),
    ...(policy?.mappings.map((mapping) => mapping.labelId) ?? []),
  ]);
  const mappings: LabelExpertMapping[] = [];
  for (const rawId of ids) {
    const labelId = parsePositiveInteger(rawId);
    if (!labelId || String(labelId) !== rawId)
      throw new RoutingFormError("L’identifiant d’un label est invalide.");
    if (!knownIds.has(labelId)) {
      throw new RoutingFormError(
        "Un label du formulaire a été supprimé ou recréé dans GitHub. Les labels actuels sont affichés ; vérifiez vos choix avant d’enregistrer à nouveau.",
        409,
      );
    }
    const value = body[`label_${labelId}`];
    if (value === "none") {
      mappings.push({ labelId, target: { kind: "none" } });
      continue;
    }
    if (
      typeof value !== "string" ||
      !value.startsWith("expert:") ||
      !isExpertIntention(value.slice(7))
    ) {
      throw new RoutingFormError(
        "Choisissez une association valide pour chaque label.",
      );
    }
    mappings.push({
      labelId,
      target: { kind: "expert", expertId: value.slice(7) },
    });
  }
  return {
    ...scope,
    defaultBehavior: DEFAULT_UNMAPPED_LABEL_BEHAVIOR,
    mappings,
  };
}
