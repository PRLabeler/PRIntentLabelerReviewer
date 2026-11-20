import type { RoutingRepositoryLabel } from "./expert-routing.js";

export type GitHubRepository = {
  id: number;
  owner: string;
  name: string;
};

export type GitHubRepositoryLabel = RoutingRepositoryLabel & {
  description: string | null;
};

export type GitHubRepositoryLabelCatalog = {
  repository: GitHubRepository;
  labels: GitHubRepositoryLabel[];
};
