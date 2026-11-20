import type { GitHubRepositoryLabel } from "../domain/github-repository.js";
import { isAiLabelName } from "../labels/ai-label-name.js";

type GitHubLabelData = {
  id: number;
  name: string;
  description?: string | null;
};

// Le catalogue de routage conserve les identifiants et la description brute.
// Les variantes créées par le bot ne sont pas des labels de taxonomie.
export function buildRepositoryLabelCatalog(
  labels: readonly GitHubLabelData[],
): GitHubRepositoryLabel[] {
  return labels
    .filter((label) => !isAiLabelName(label.name))
    .map((label) => ({
      id: label.id,
      name: label.name,
      description: label.description ?? null,
    }));
}
