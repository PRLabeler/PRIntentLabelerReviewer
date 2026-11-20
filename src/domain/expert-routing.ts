import type { LabelSuggestion } from "./label-suggestion.js";

export const DEFAULT_UNMAPPED_LABEL_BEHAVIOR = "general";

// Anciennes valeurs PostgreSQL conservées pour lire les politiques et audits.
export type UnmappedLabelBehavior = "none" | "general";

export type ExpertRoutingScope = {
  installationId: number;
  repositoryId: number;
};

// Le nom sert à retrouver une suggestion dans le catalogue courant. Seul
// l'identifiant GitHub sert à retrouver sa correspondance enregistrée.
export type RoutingRepositoryLabel = {
  id: number;
  name: string;
};

export type LabelExpertTarget =
  | { kind: "expert"; expertId: string }
  | { kind: "none" };

// Sans correspondance, un label utilise Général. Une entrée kind: "none"
// désactive explicitement la revue pour ce label.
export type LabelExpertMapping = {
  labelId: number;
  target: LabelExpertTarget;
};

export type RepositoryRoutingPolicy = ExpertRoutingScope & {
  // Compatibilité du stockage historique uniquement ; sans effet sur le routage.
  // Les nouvelles sauvegardes utilisent toujours "general".
  defaultBehavior: UnmappedLabelBehavior;
  mappings: readonly LabelExpertMapping[];
};

export type ExpertRoutingSource = "explicit" | "default" | "legacy";

export type ExpertRoutingTrigger = LabelSuggestion & {
  // Un ancien routage peut fonctionner sans catalogue d'identifiants.
  labelId: number | null;
  source: ExpertRoutingSource;
};

export type ExpertRoutingCandidate = {
  expertId: string;
  // Confiance maximale des déclencheurs de l'origine prioritaire. Un label
  // utilisant le défaut ne renforce pas une association explicite.
  confidence: number;
  source: ExpertRoutingSource;
  triggeringLabels: readonly ExpertRoutingTrigger[];
};

export type ExpertRoutingPlan = {
  mode: "legacy" | "configured";
  candidates: readonly ExpertRoutingCandidate[];
  // La V1 ne doit exécuter que cet expert. Les autres candidats permettent
  // d'expliquer le choix et de préparer une future orchestration multiple.
  selectedExpert: ExpertRoutingCandidate | null;
};

export type ExpertRoutingInput = {
  scope: ExpertRoutingScope;
  // null signifie uniquement une lecture réussie sans politique enregistrée.
  // Une erreur du futur lecteur doit être propagée, jamais convertie en null.
  policy: RepositoryRoutingPolicy | null;
  repositoryLabels: readonly RoutingRepositoryLabel[];
  // Suggestions déjà validées et triées par le système de labels existant.
  suggestions: readonly LabelSuggestion[];
  // Identifiants fournis par le registre des experts, sans taxonomie dupliquée.
  availableExpertIds: readonly string[];
};
