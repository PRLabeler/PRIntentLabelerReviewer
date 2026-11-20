import { ProbotOctokit } from "probot";
import { describe, expect, it, vi } from "vitest";
import {
  InstallationRepositoryReader,
  RepositoryNotAccessibleError,
  type InstallationRepositoryClient,
} from "../src/github/installation-repository-reader.js";
import { toAiLabelName } from "../src/labels/ai-label-name.js";

function repository(id: number, name = "repo", owner = "org") {
  return { id, name, owner: { login: owner } };
}

function mockReader() {
  const client = {
    apps: {
      listReposAccessibleToInstallation: vi.fn().mockResolvedValue({
        data: { total_count: 1, repositories: [repository(123)] },
      }),
    },
    issues: {
      listLabelsForRepo: vi.fn().mockResolvedValue({
        data: [
          { id: 10, name: "bug", description: "Corrige un défaut" },
          { id: 11, name: "feature", description: null },
          { id: 12, name: "tests" },
          { id: 13, name: toAiLabelName("bug"), description: "Label du bot" },
        ],
      }),
    },
  };
  const authenticate = vi.fn(
    async () => client as unknown as InstallationRepositoryClient,
  );
  return {
    client,
    authenticate,
    reader: new InstallationRepositoryReader(authenticate),
  };
}

// Vrai client et vraie pagination Octokit, mais toutes les requêtes sont
// interceptées en mémoire. Aucun accès à GitHub ni jeton réel n'est nécessaire.
function paginatedReader(failure?: "repositories" | "labels") {
  const fetch = vi.fn(async (url: string) => {
    const request = new URL(url);
    const secondPage = request.searchParams.get("page") === "2";
    if (request.pathname === "/installation/repositories") {
      if (secondPage && failure === "repositories") {
        return Response.json({ message: "Forbidden" }, { status: 403 });
      }
      const repositories = secondPage
        ? [repository(123)]
        : [repository(99, "other")];
      const headers = secondPage
        ? {}
        : {
            link: '<https://api.github.com/installation/repositories?per_page=100&page=2>; rel="next"',
          };
      return Response.json({ total_count: 2, repositories }, { headers });
    }
    if (request.pathname === "/repos/org/repo/labels") {
      if (secondPage && failure === "labels") {
        return Response.json(
          { message: "Rate limit exceeded" },
          {
            status: 429,
            headers: { "retry-after": "1" },
          },
        );
      }
      const labels = secondPage
        ? [{ id: 11, name: "cleanup", description: null }]
        : [{ id: 10, name: "bug", description: "Corrige un défaut" }];
      const headers = secondPage
        ? {}
        : {
            link: '<https://api.github.com/repos/org/repo/labels?per_page=100&page=2>; rel="next"',
          };
      return Response.json(labels, { headers });
    }
    throw new Error(`Requête inattendue : ${request.pathname}`);
  });
  const client = new ProbotOctokit({
    auth: "test-token",
    authStrategy: undefined,
    throttle: { enabled: false },
    retry: { enabled: false },
    request: { fetch },
  });
  const authenticate = vi.fn(async () => client);
  return {
    fetch,
    authenticate,
    reader: new InstallationRepositoryReader(authenticate),
  };
}

describe("InstallationRepositoryReader", () => {
  it("récupère les dépôts avec le client de l'installation", async () => {
    const { reader, authenticate, client } = mockReader();

    expect(await reader.listRepositories(42)).toEqual([
      { id: 123, name: "repo", owner: "org" },
    ]);
    expect(authenticate).toHaveBeenCalledWith(42);
    expect(client.apps.listReposAccessibleToInstallation).toHaveBeenCalledWith({
      per_page: 100,
    });
    expect(client.issues.listLabelsForRepo).not.toHaveBeenCalled();
  });

  it("charge les labels du dépôt avec leurs identifiants et descriptions", async () => {
    const { reader, authenticate, client } = mockReader();

    expect(await reader.readRepositoryLabels(42, 123)).toEqual({
      repository: { id: 123, name: "repo", owner: "org" },
      labels: [
        { id: 10, name: "bug", description: "Corrige un défaut" },
        { id: 11, name: "feature", description: null },
        { id: 12, name: "tests", description: null },
      ],
    });
    expect(authenticate).toHaveBeenCalledTimes(1);
    expect(client.issues.listLabelsForRepo).toHaveBeenCalledWith({
      owner: "org",
      repo: "repo",
      per_page: 100,
    });
  });

  it("refuse un dépôt absent de l'installation sans lire ses labels", async () => {
    const { reader, client } = mockReader();

    await expect(reader.readRepositoryLabels(42, 999)).rejects.toBeInstanceOf(
      RepositoryNotAccessibleError,
    );
    expect(client.issues.listLabelsForRepo).not.toHaveBeenCalled();
  });

  it("ne réutilise pas le catalogue d'une autre installation", async () => {
    const { reader, authenticate, client } = mockReader();
    await reader.readRepositoryLabels(42, 123);
    client.apps.listReposAccessibleToInstallation.mockResolvedValue({
      data: {
        total_count: 1,
        repositories: [repository(456, "private", "another-org")],
      },
    });

    await expect(reader.readRepositoryLabels(43, 123)).rejects.toBeInstanceOf(
      RepositoryNotAccessibleError,
    );
    expect(authenticate.mock.calls).toEqual([[42], [43]]);
    expect(client.issues.listLabelsForRepo).toHaveBeenCalledTimes(1);
  });

  it("distingue une installation vide d'une erreur GitHub", async () => {
    const { reader, client } = mockReader();
    client.apps.listReposAccessibleToInstallation.mockResolvedValue({
      data: { total_count: 0, repositories: [] },
    });

    expect(await reader.listRepositories(42)).toEqual([]);
    await expect(reader.readRepositoryLabels(42, 123)).rejects.toBeInstanceOf(
      RepositoryNotAccessibleError,
    );
  });

  it("accepte un dépôt sans labels", async () => {
    const { reader, client } = mockReader();
    client.issues.listLabelsForRepo.mockResolvedValue({ data: [] });

    expect((await reader.readRepositoryLabels(42, 123)).labels).toEqual([]);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])(
    "refuse un identifiant invalide avant authentification : %s",
    async (id) => {
      const { reader, authenticate } = mockReader();
      await expect(reader.listRepositories(id)).rejects.toThrow(
        "entier positif sûr",
      );
      await expect(reader.readRepositoryLabels(42, id)).rejects.toThrow(
        "entier positif sûr",
      );
      expect(authenticate).not.toHaveBeenCalled();
    },
  );

  it("propage une erreur d'authentification", async () => {
    const { reader, authenticate } = mockReader();
    const error = Object.assign(new Error("Installation inconnue"), {
      status: 404,
    });
    authenticate.mockRejectedValue(error);

    await expect(reader.listRepositories(42)).rejects.toBe(error);
    await expect(reader.readRepositoryLabels(42, 123)).rejects.toBe(error);
  });

  it.each([403, 404, 429, 500])(
    "propage une erreur GitHub %s sans retourner de liste vide",
    async (status) => {
      const { reader, client } = mockReader();
      const error = Object.assign(new Error("Erreur GitHub"), { status });
      client.apps.listReposAccessibleToInstallation.mockRejectedValueOnce(
        error,
      );
      await expect(reader.listRepositories(42)).rejects.toBe(error);
      client.issues.listLabelsForRepo.mockRejectedValueOnce(error);
      await expect(reader.readRepositoryLabels(42, 123)).rejects.toBe(error);
    },
  );

  it("récupère toutes les pages de dépôts avec la pagination Octokit réelle", async () => {
    const { reader, fetch } = paginatedReader();

    expect(await reader.listRepositories(42)).toEqual([
      { id: 99, name: "other", owner: "org" },
      { id: 123, name: "repo", owner: "org" },
    ]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("trouve un dépôt en deuxième page et récupère toutes ses pages de labels", async () => {
    const { reader, fetch } = paginatedReader();

    expect(await reader.readRepositoryLabels(42, 123)).toEqual({
      repository: { id: 123, name: "repo", owner: "org" },
      labels: [
        { id: 10, name: "bug", description: "Corrige un défaut" },
        { id: 11, name: "cleanup", description: null },
      ],
    });
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it.each([
    { phase: "repositories" as const, status: 403 },
    { phase: "labels" as const, status: 429 },
  ])(
    "rejette une erreur sur une page ultérieure : $phase",
    async ({ phase, status }) => {
      const { reader } = paginatedReader(phase);

      await expect(reader.readRepositoryLabels(42, 123)).rejects.toMatchObject({
        status,
      });
    },
  );
});
