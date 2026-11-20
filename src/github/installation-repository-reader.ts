import type { Context } from "probot";
import type {
  GitHubRepository,
  GitHubRepositoryLabelCatalog,
} from "../domain/github-repository.js";
import { listAllPages } from "./pagination.js";
import { buildRepositoryLabelCatalog } from "./repository-labels.js";

type Octokit = Context<"pull_request">["octokit"];

export type InstallationRepositoryClient = {
  apps: Pick<Octokit["apps"], "listReposAccessibleToInstallation">;
  issues: Pick<Octokit["issues"], "listLabelsForRepo">;
  paginate?: Octokit["paginate"];
};

export type AuthenticateInstallation = (
  installationId: number,
) => Promise<InstallationRepositoryClient>;

export class RepositoryNotAccessibleError extends Error {
  constructor() {
    super("Ce dépôt n’est pas accessible à cette installation GitHub.");
    this.name = "RepositoryNotAccessibleError";
  }
}

function assertPositiveId(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error("L’identifiant GitHub doit être un entier positif sûr.");
  }
}

async function listInstallationRepositories(
  client: InstallationRepositoryClient,
): Promise<GitHubRepository[]> {
  const repositories = await listAllPages(
    client,
    client.apps.listReposAccessibleToInstallation,
    { per_page: 100 },
  );

  return repositories.map((repository) => ({
    id: repository.id,
    owner: repository.owner.login,
    name: repository.name,
  }));
}

/**
 * Lecteur injectable dans les futures routes des paramètres via app.auth.
 * L'autorisation de la session reste à la charge de la couche HTTP.
 * Les erreurs GitHub sont propagées : une panne n'est jamais une liste vide.
 */
export class InstallationRepositoryReader {
  constructor(private readonly authenticate: AuthenticateInstallation) {}

  async listRepositories(installationId: number): Promise<GitHubRepository[]> {
    assertPositiveId(installationId);
    const client = await this.authenticate(installationId);
    return listInstallationRepositories(client);
  }

  async readRepositoryLabels(
    installationId: number,
    repositoryId: number,
  ): Promise<GitHubRepositoryLabelCatalog> {
    assertPositiveId(installationId);
    assertPositiveId(repositoryId);
    const client = await this.authenticate(installationId);
    const repositories = await listInstallationRepositories(client);
    const repository = repositories.find((entry) => entry.id === repositoryId);
    if (!repository) {
      throw new RepositoryNotAccessibleError();
    }

    const labels = await listAllPages(client, client.issues.listLabelsForRepo, {
      owner: repository.owner,
      repo: repository.name,
      per_page: 100,
    });

    return { repository, labels: buildRepositoryLabelCatalog(labels) };
  }
}
