import { describe, expect, it } from "vitest";
import {
  DEFAULT_UNMAPPED_LABEL_BEHAVIOR,
  type ExpertRoutingInput,
  type RepositoryRoutingPolicy,
} from "../src/domain/expert-routing.js";
import type { LabelSuggestion } from "../src/domain/label-suggestion.js";
import { filterValidSuggestions } from "../src/labels/label-policy.js";
import { registeredIntents } from "../src/review/expert-policies.js";
import {
  buildExpertRoutingPlan,
  InvalidExpertRoutingPolicyError,
} from "../src/review/expert-routing.js";
import { selectPrimaryReviewIntent } from "../src/review/select-review-intent.js";

const scope = { installationId: 42, repositoryId: 100 };
const repositoryLabels = [
  { id: 1, name: "bug" },
  { id: 2, name: "enhancement" },
  { id: 3, name: "cleanup" },
  { id: 4, name: "question" },
  { id: 5, name: "security" },
  { id: 6, name: "regression" },
];

function suggestion(name: string, confidence = 0.9): LabelSuggestion {
  return { name, confidence, reason: `Preuve pour ${name}` };
}

function policy(
  overrides: Partial<RepositoryRoutingPolicy> = {},
): RepositoryRoutingPolicy {
  return {
    ...scope,
    defaultBehavior: DEFAULT_UNMAPPED_LABEL_BEHAVIOR,
    mappings: [],
    ...overrides,
  };
}

function route(
  suggestions: LabelSuggestion[],
  routingPolicy: RepositoryRoutingPolicy | null = policy(),
  overrides: Partial<ExpertRoutingInput> = {},
) {
  return buildExpertRoutingPlan({
    scope,
    policy: routingPolicy,
    repositoryLabels,
    suggestions,
    availableExpertIds: registeredIntents(),
    ...overrides,
  });
}

describe("contrats et règles du routage des experts", () => {
  it("route une politique vide vers Général sans réactiver le routage historique", () => {
    expect(DEFAULT_UNMAPPED_LABEL_BEHAVIOR).toBe("general");
    const result = route(
      [suggestion("bug")],
      policy({ defaultBehavior: "none" }),
    );
    expect(result.mode).toBe("configured");
    expect(result.selectedExpert).toMatchObject({
      expertId: "general",
      source: "default",
    });
  });

  it("résout un alias sans modifier le label suggéré", () => {
    const result = route(
      [suggestion("enhancement", 0.95)],
      policy({
        mappings: [
          { labelId: 2, target: { kind: "expert", expertId: "feature" } },
        ],
      }),
    );
    expect(result.selectedExpert).toEqual({
      expertId: "feature",
      confidence: 0.95,
      source: "explicit",
      triggeringLabels: [
        { ...suggestion("enhancement", 0.95), labelId: 2, source: "explicit" },
      ],
    });
  });

  it.each(["none", "general"] as const)(
    "Aucun explicite reste respecté avec l'ancien champ de stockage %s",
    (defaultBehavior) => {
      const result = route(
        [suggestion("question", 0.99)],
        policy({
          defaultBehavior,
          mappings: [{ labelId: 4, target: { kind: "none" } }],
        }),
      );
      expect(result.selectedExpert).toBeNull();
    },
  );

  it("Aucun explicite ne bloque pas les autres labels de la PR", () => {
    const result = route(
      [suggestion("question", 0.99), suggestion("bug", 0.8)],
      policy({
        mappings: [
          { labelId: 4, target: { kind: "none" } },
          { labelId: 1, target: { kind: "expert", expertId: "bug" } },
        ],
      }),
    );
    expect(result.selectedExpert?.expertId).toBe("bug");
  });

  it("peut associer explicitement un label à Général", () => {
    const result = route(
      [suggestion("cleanup")],
      policy({
        mappings: [
          { labelId: 3, target: { kind: "expert", expertId: "general" } },
        ],
      }),
    );
    expect(result.selectedExpert).toMatchObject({
      expertId: "general",
      source: "explicit",
    });
  });

  it("utilise Général par défaut pour les labels nouveaux ou non associés", () => {
    const result = route(
      [suggestion("new-label", 0.94)],
      policy({ defaultBehavior: "general" }),
      { repositoryLabels: [{ id: 50, name: "new-label" }] },
    );
    expect(result.selectedExpert).toMatchObject({
      expertId: "general",
      source: "default",
      confidence: 0.94,
    });
  });

  it("ne déclenche pas Général sans suggestion", () => {
    expect(
      route([], policy({ defaultBehavior: "general" })).selectedExpert,
    ).toBeNull();
  });

  it("privilégie une association explicite sur un défaut plus confiant", () => {
    const result = route(
      [suggestion("question", 0.99), suggestion("security", 0.72)],
      policy({
        defaultBehavior: "general",
        mappings: [
          { labelId: 5, target: { kind: "expert", expertId: "security" } },
        ],
      }),
    );
    expect(result.candidates.map((candidate) => candidate.expertId)).toEqual([
      "security",
      "general",
    ]);
    expect(result.selectedExpert?.expertId).toBe("security");
  });

  it("regroupe les labels d'un expert sans additionner les confiances", () => {
    const result = route(
      [suggestion("regression", 0.88), suggestion("bug", 0.95)],
      policy({
        mappings: [
          { labelId: 1, target: { kind: "expert", expertId: "bug" } },
          { labelId: 6, target: { kind: "expert", expertId: "bug" } },
        ],
      }),
    );
    expect(result.candidates).toHaveLength(1);
    expect(result.selectedExpert?.confidence).toBe(0.95);
    expect(
      result.selectedExpert?.triggeringLabels.map((label) => label.name),
    ).toEqual(["regression", "bug"]);
  });

  it("sélectionne la meilleure confiance entre les experts explicites", () => {
    const result = route(
      [suggestion("bug", 0.8), suggestion("enhancement", 0.96)],
      policy({
        mappings: [
          { labelId: 1, target: { kind: "expert", expertId: "bug" } },
          { labelId: 2, target: { kind: "expert", expertId: "feature" } },
        ],
      }),
    );
    expect(result.candidates).toHaveLength(2);
    expect(result.selectedExpert).toBe(result.candidates[0]);
    expect(result.selectedExpert?.expertId).toBe("feature");
  });

  it.each([false, true])(
    "départage les égalités par identifiant, ordre inversé : %s",
    (reverse) => {
      const suggestions = [suggestion("enhancement"), suggestion("bug")];
      if (reverse) suggestions.reverse();
      const result = route(
        suggestions,
        policy({
          mappings: [
            { labelId: 2, target: { kind: "expert", expertId: "feature" } },
            { labelId: 1, target: { kind: "expert", expertId: "bug" } },
          ],
        }),
      );
      expect(result.candidates.map((candidate) => candidate.expertId)).toEqual([
        "bug",
        "feature",
      ]);
    },
  );

  it.each([false, true])(
    "un défaut ne gonfle pas la confiance de Général explicite, ordre inversé : %s",
    (reverse) => {
      const suggestions = [
        suggestion("question", 0.99),
        suggestion("cleanup", 0.71),
        suggestion("bug", 0.9),
      ];
      if (reverse) suggestions.reverse();
      const result = route(
        suggestions,
        policy({
          defaultBehavior: "general",
          mappings: [
            { labelId: 3, target: { kind: "expert", expertId: "general" } },
            { labelId: 1, target: { kind: "expert", expertId: "bug" } },
          ],
        }),
      );
      expect(result.selectedExpert?.expertId).toBe("bug");
      expect(result.candidates[1]).toMatchObject({
        expertId: "general",
        source: "explicit",
        confidence: 0.71,
      });
      expect(result.candidates[1].triggeringLabels).toHaveLength(2);
    },
  );

  it("conserve une correspondance après renommage du label", () => {
    const result = route(
      [suggestion("restructuring")],
      policy({
        mappings: [
          { labelId: 3, target: { kind: "expert", expertId: "refactor" } },
        ],
      }),
      { repositoryLabels: [{ id: 3, name: "restructuring" }] },
    );
    expect(result.selectedExpert?.expertId).toBe("refactor");
    expect(result.selectedExpert?.triggeringLabels[0].labelId).toBe(3);
  });

  it.each(["none", "general"] as const)(
    "route un label recréé vers Général sans réutiliser l'ancienne règle, champ historique %s",
    (defaultBehavior) => {
      const result = route(
        [suggestion("cleanup")],
        policy({
          defaultBehavior,
          mappings: [
            { labelId: 3, target: { kind: "expert", expertId: "refactor" } },
          ],
        }),
        { repositoryLabels: [{ id: 30, name: "cleanup" }] },
      );
      expect(result.selectedExpert?.expertId).toBe("general");
    },
  );

  it("ignore un label supprimé même quand le défaut est Général", () => {
    const result = route(
      [suggestion("cleanup")],
      policy({
        defaultBehavior: "general",
        mappings: [
          { labelId: 3, target: { kind: "expert", expertId: "refactor" } },
        ],
      }),
      { repositoryLabels: [] },
    );
    expect(result.selectedExpert).toBeNull();
  });

  it.each([{ installationId: 43 }, { repositoryId: 101 }])(
    "refuse une politique d'une autre portée : %j",
    (otherScope) => {
      expect(() => route([suggestion("bug")], policy(otherScope))).toThrow(
        InvalidExpertRoutingPolicyError,
      );
    },
  );

  it.each([0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])(
    "refuse les identifiants de portée invalides : %s",
    (id) => {
      expect(() =>
        route([], policy(), { scope: { ...scope, repositoryId: id } }),
      ).toThrow(InvalidExpertRoutingPolicyError);
    },
  );

  it("refuse les doublons de règles au lieu de choisir silencieusement", () => {
    expect(() =>
      route(
        [suggestion("bug")],
        policy({
          mappings: [
            { labelId: 1, target: { kind: "none" } },
            { labelId: 1, target: { kind: "expert", expertId: "bug" } },
          ],
        }),
      ),
    ).toThrow(InvalidExpertRoutingPolicyError);
  });

  it("refuse un identifiant de label invalide", () => {
    expect(() =>
      route(
        [],
        policy({ mappings: [{ labelId: 0, target: { kind: "none" } }] }),
      ),
    ).toThrow(InvalidExpertRoutingPolicyError);
  });

  it("refuse un expert absent du registre sans repli historique ou Général", () => {
    expect(() =>
      route(
        [suggestion("bug")],
        policy({
          defaultBehavior: "general",
          mappings: [
            { labelId: 1, target: { kind: "expert", expertId: "unknown" } },
          ],
        }),
      ),
    ).toThrow(InvalidExpertRoutingPolicyError);
  });

  it("n'active pas Général si cette capacité n'est pas fournie par le registre", () => {
    expect(() =>
      route([], policy({ defaultBehavior: "general" }), {
        availableExpertIds: registeredIntents().filter(
          (id) => id !== "general",
        ),
      }),
    ).toThrow(InvalidExpertRoutingPolicyError);
  });

  it("ne traite pas une lecture indéfinie comme une absence de politique", () => {
    expect(() =>
      buildExpertRoutingPlan({
        scope,
        // @ts-expect-error Une lecture réussie doit retourner une politique ou null.
        policy: undefined,
        repositoryLabels,
        suggestions: [suggestion("bug")],
        availableExpertIds: registeredIntents(),
      }),
    ).toThrow(InvalidExpertRoutingPolicyError);
  });

  it.each([
    [],
    [suggestion("enhancement", 0.99)],
    [suggestion("feature", 0.96), suggestion("bug", 0.91)],
    [suggestion("feature", 0.9), suggestion("bug", 0.9)],
    [suggestion("bug", 0.9), suggestion("feature", 0.9)],
    [suggestion("BUG", 0.95)],
  ])(
    "conserve la sélection historique sans politique : %j",
    (...suggestions) => {
      const result = route(suggestions, null, {
        availableExpertIds: registeredIntents(),
        repositoryLabels: [],
      });
      expect(result.mode).toBe("legacy");
      expect(result.selectedExpert?.expertId ?? null).toBe(
        selectPrimaryReviewIntent(suggestions),
      );
      if (result.selectedExpert) {
        expect(result.selectedExpert.source).toBe("legacy");
        expect(result.selectedExpert.triggeringLabels[0].labelId).toBeNull();
      }
    },
  );

  it("consomme la validation existante sans modifier ses seuils ni ses labels", () => {
    const validated = filterValidSuggestions(
      [
        suggestion("enhancement", 0.7),
        suggestion("bug", 0.69),
        suggestion("unknown", 0.99),
      ],
      repositoryLabels.map((label) => label.name),
    );
    const before = structuredClone(validated);
    const result = route(
      validated,
      policy({
        mappings: [
          { labelId: 2, target: { kind: "expert", expertId: "feature" } },
        ],
      }),
    );
    expect(result.selectedExpert?.confidence).toBe(0.7);
    expect(result.selectedExpert?.expertId).toBe("feature");
    expect(validated).toEqual(before);
    expect(validated.map((entry) => entry.name)).toEqual(["enhancement"]);
  });

  it("ne modifie ni la politique, ni le catalogue, ni les suggestions", () => {
    const input: ExpertRoutingInput = {
      scope,
      policy: policy({
        defaultBehavior: "general",
        mappings: [{ labelId: 1, target: { kind: "expert", expertId: "bug" } }],
      }),
      repositoryLabels,
      suggestions: [suggestion("question", 0.99), suggestion("bug", 0.8)],
      availableExpertIds: registeredIntents(),
    };
    const before = structuredClone(input);
    buildExpertRoutingPlan(input);
    expect(input).toEqual(before);
  });
});
