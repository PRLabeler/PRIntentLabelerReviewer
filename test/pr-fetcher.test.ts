import { describe, expect, it, vi } from "vitest";
import { fetchPullRequestData } from "../src/github/pr-fetcher.js";
import { toAiLabelName } from "../src/labels/ai-label-name.js";
import { buildPullRequestLlmContext } from "../src/llm/pr-context.js";
import { buildClassificationPrompt } from "../src/llm/prompt-builder.js";

function mockClient() {
  return {
    pulls: {
      get: vi.fn().mockResolvedValue({
        data: {
          number: 42,
          title: "Fix login bug",
          body: "Closes #1",
          user: { login: "author" },
          base: { ref: "main", repo: { id: 123 } },
          head: { ref: "fix-login", sha: "head-sha", repo: { id: 999 } },
          html_url: "https://github.com/org/repo/pull/42",
          additions: 1,
          deletions: 1,
          changed_files: 1,
        },
      }),
      listFiles: vi.fn().mockResolvedValue({
        data: [
          {
            filename: "src/login.ts",
            status: "modified",
            additions: 1,
            deletions: 1,
            changes: 2,
            patch: "@@ -1 +1 @@\n-old\n+new",
          },
        ],
      }),
    },
    issues: {
      listLabelsForRepo: vi.fn().mockResolvedValue({
        data: [
          { id: 10, name: "bug", description: "  Corrige un défaut  " },
          { id: 11, name: "feature", description: null },
          { id: 12, name: toAiLabelName("bug"), description: "Label du bot" },
        ],
      }),
      listLabelsOnIssue: vi.fn().mockResolvedValue({ data: [{ name: "bug" }] }),
    },
  };
}

function read(client: ReturnType<typeof mockClient>) {
  return fetchPullRequestData(
    client as unknown as Parameters<typeof fetchPullRequestData>[0],
    "org",
    "repo",
    42,
  );
}

describe("fetchPullRequestData", () => {
  it("conserve l'identifiant du dépôt cible et les identifiants des labels", async () => {
    const client = mockClient();
    const result = await read(client);

    expect(result.repositoryId).toBe(123);
    expect(result.repositoryLabelCatalog).toEqual([
      { id: 10, name: "bug", description: "  Corrige un défaut  " },
      { id: 11, name: "feature", description: null },
    ]);
    expect(result.headSha).toBe("head-sha");
    expect(result.pullRequestLabels).toEqual(["bug"]);
    expect(result.files[0].patch).toBe("@@ -1 +1 @@\n-old\n+new");
    expect(client.pulls.get).toHaveBeenCalledWith({
      owner: "org",
      repo: "repo",
      pull_number: 42,
    });
    expect(client.issues.listLabelsForRepo).toHaveBeenCalledWith({
      owner: "org",
      repo: "repo",
      per_page: 100,
    });
    expect(client.issues.listLabelsOnIssue).toHaveBeenCalledWith({
      owner: "org",
      repo: "repo",
      issue_number: 42,
      per_page: 100,
    });
  });

  it("préserve les labels et descriptions du classifieur, sans transmettre les identifiants", async () => {
    const result = await read(mockClient());
    expect(result.repositoryLabels).toEqual(["bug", "feature"]);
    expect(result.repositoryLabelDescriptions).toEqual({
      bug: "Corrige un défaut",
    });
    const context = buildPullRequestLlmContext(result);
    const historicalContext = buildPullRequestLlmContext({
      ...result,
      repositoryId: undefined,
      repositoryLabelCatalog: undefined,
    });

    expect(context).toEqual(historicalContext);
    expect(buildClassificationPrompt(context)).toBe(
      buildClassificationPrompt(historicalContext),
    );
  });

  it("distingue un renommage d'une recréation de label", async () => {
    const client = mockClient();
    const original = await read(client);
    client.issues.listLabelsForRepo.mockResolvedValue({
      data: [{ id: 10, name: "correctness", description: null }],
    });
    const renamed = await read(client);
    client.issues.listLabelsForRepo.mockResolvedValue({
      data: [{ id: 50, name: "bug", description: null }],
    });
    const recreated = await read(client);

    expect(renamed.repositoryLabelCatalog?.[0].id).toBe(
      original.repositoryLabelCatalog?.[0].id,
    );
    expect(renamed.repositoryLabels).toEqual(["correctness"]);
    expect(recreated.repositoryLabels).toEqual(["bug"]);
    expect(recreated.repositoryLabelCatalog?.[0].id).toBe(50);
  });

  it("utilise la pagination existante pour les trois listes de la PR", async () => {
    const client = mockClient();
    const paginate = vi.fn(
      async (
        method: (parameters: unknown) => Promise<{ data: unknown[] }>,
        parameters: unknown,
      ) => {
        const response = await method(parameters);
        if (method === client.issues.listLabelsForRepo) {
          return [
            ...response.data,
            { id: 20, name: "cleanup", description: null },
          ];
        }
        return response.data;
      },
    );
    const paginatedClient = { ...client, paginate };
    const result = await read(paginatedClient);

    expect(paginate).toHaveBeenCalledTimes(3);
    expect(result.repositoryLabelCatalog?.map((label) => label.id)).toEqual([
      10, 11, 20,
    ]);
    expect(result.repositoryLabels).toEqual(["bug", "feature", "cleanup"]);
    expect(client.pulls.get).toHaveBeenCalledTimes(1);
  });

  it.each([
    "get",
    "listFiles",
    "listLabelsForRepo",
    "listLabelsOnIssue",
  ] as const)("propage une erreur GitHub sur %s", async (method) => {
    const client = mockClient();
    const error = Object.assign(new Error("GitHub indisponible"), {
      status: 403,
    });
    if (method === "get" || method === "listFiles") {
      client.pulls[method].mockRejectedValue(error);
    } else {
      client.issues[method].mockRejectedValue(error);
    }

    await expect(read(client)).rejects.toBe(error);
  });
});
