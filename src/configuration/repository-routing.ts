import type {
  ExpertRoutingScope,
  LabelExpertMapping,
  RepositoryRoutingPolicy,
} from "../domain/expert-routing.js";
import type { GitHubRepositoryLabelCatalog } from "../domain/github-repository.js";

export type NamedLabelExpertMapping = LabelExpertMapping & {
  // Dernier nom observé, jamais utilisé comme clé de correspondance.
  labelName: string;
};

export type StoredRepositoryRoutingPolicy = Omit<
  RepositoryRoutingPolicy,
  "mappings"
> & {
  mappings: readonly NamedLabelExpertMapping[];
  createdByGithubUserId: number | null;
  updatedByGithubUserId: number | null;
  createdAt: Date;
  updatedAt: Date;
};

export type SaveRepositoryRoutingPolicy = Omit<
  RepositoryRoutingPolicy,
  "mappings"
> & {
  mappings: readonly NamedLabelExpertMapping[];
  githubUserId?: number;
};

export type ChangeRepositoryRoutingPolicyInput = RepositoryRoutingPolicy & {
  // Catalogue lu par InstallationRepositoryReader à l'étape 2. La couche HTTP
  // devra vérifier l'utilisateur et l'installation avant de le fournir.
  catalog: GitHubRepositoryLabelCatalog;
  githubUserId?: number;
};

export interface RepositoryRoutingRepository {
  // null = lecture réussie sans politique ; une erreur reste une erreur.
  findByRepository(
    scope: ExpertRoutingScope,
  ): Promise<StoredRepositoryRoutingPolicy | null>;
  // Remplacement complet et atomique, y compris pour une liste vide.
  upsert(
    input: SaveRepositoryRoutingPolicy,
  ): Promise<StoredRepositoryRoutingPolicy>;
  deleteForInstallation(
    installationId: number,
    githubUserId?: number,
  ): Promise<number>;
}

export class RepositoryRoutingUnavailableError extends Error {
  constructor() {
    super("Le service de configuration du routage est indisponible.");
    this.name = "RepositoryRoutingUnavailableError";
  }
}

export class RepositoryRoutingSchemaMissingError extends RepositoryRoutingUnavailableError {
  constructor() {
    super();
    this.name = "RepositoryRoutingSchemaMissingError";
    this.message =
      "Le schéma PostgreSQL des correspondances est absent ou incomplet. La migration 003 est requise : exécutez npm run db:migrate sur le serveur.";
  }
}

export class RepositoryRoutingValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RepositoryRoutingValidationError";
  }
}
