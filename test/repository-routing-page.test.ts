import { describe, expect, it } from "vitest";
import type { StoredRepositoryRoutingPolicy } from "../src/configuration/repository-routing.js";
import type { GitHubRepositoryLabelCatalog } from "../src/domain/github-repository.js";
import { buildRoutingLabelRows } from "../src/http/repository-routing-form.js";
import { renderExpertsSettings } from "../src/http/repository-routing-page.js";

const catalog: GitHubRepositoryLabelCatalog = {
  repository: { id: 123, owner: "org", name: "repo" },
  labels: [
    { id: 10, name: "bug", description: "Corrige un défaut" },
    { id: 11, name: "enhancement", description: null },
    { id: 12, name: "refactor", description: null },
    { id: 13, name: "security", description: null },
    { id: 14, name: "question", description: null },
  ],
};
const policy: StoredRepositoryRoutingPolicy = {
  installationId: 42,
  repositoryId: 123,
  defaultBehavior: "general",
  mappings: [{ labelId: 10, labelName: "bug", target: { kind: "none" } }],
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z"),
  createdByGithubUserId: 7,
  updatedByGithubUserId: 7,
};

describe("page des correspondances", () => {
  it("propose Général sans correspondance et conserve les choix enregistrés, même avec une ancienne politique vide", () => {
    const initial = buildRoutingLabelRows(catalog, null);
    expect(initial.map((row) => row.selection)).toEqual([
      "expert:general",
      "expert:general",
      "expert:general",
      "expert:general",
      "expert:general",
    ]);
    expect(initial.filter((row) => row.proposed)).toHaveLength(5);
    const saved = buildRoutingLabelRows(catalog, policy);
    expect(saved[0].selection).toBe("none");
    expect(saved[1].selection).toBe("expert:general");
    expect(saved[0].proposed).toBe(false);
    expect(saved[1].proposed).toBe(true);
    expect(
      buildRoutingLabelRows(catalog, {
        ...policy,
        defaultBehavior: "none",
        mappings: [],
      }).every((row) => row.selection === "expert:general"),
    ).toBe(true);
  });

  it("distingue un label recréé de sa règle orpheline, même avec le même nom", () => {
    const rows = buildRoutingLabelRows(
      { ...catalog, labels: [{ id: 50, name: "bug", description: null }] },
      policy,
    );
    expect(
      rows.map((row) => ({
        id: row.labelId,
        missing: row.missing,
        selection: row.selection,
      })),
    ).toEqual([
      { id: 50, missing: false, selection: "expert:general" },
      { id: 10, missing: true, selection: "none" },
    ]);
  });

  it("échappe les données GitHub et affiche tous les types d'association sans script", () => {
    const html = renderExpertsSettings(
      42,
      {
        githubUserId: 7,
        githubLogin: "user",
        installationIds: [42],
        csrfToken: 'csrf"<token>',
        expiresAt: new Date(),
      },
      {
        repositories: [{ id: 123, owner: "<org>", name: "<repo>" }],
        repositoryId: 123,
        catalog: {
          repository: { id: 123, owner: "<org>", name: "<repo>" },
          labels: [
            {
              id: 10,
              name: "<script>",
              description: '<img src=x onerror="bad()">',
            },
          ],
        },
        policy,
      },
    );
    expect(html).toContain("&lt;org&gt;/&lt;repo&gt;");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;img src=x onerror=&quot;bad()&quot;&gt;");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html).toContain('value="csrf&quot;&lt;token&gt;"');
    expect(html).toContain(
      '<option value="none" selected>Aucun expert</option>',
    );
    expect(html).toContain(
      '<option value="expert:general">Expert Général</option>',
    );
    expect(html).not.toContain('value="inherit"');
    expect(html).not.toContain("Défaut du dépôt");
    expect(html).not.toContain('name="defaultBehavior"');
    expect(html).not.toContain(">Afficher</button>");
    expect(html).toContain(
      '<a class="button secondary" href="/settings/42/experts/general">',
    );
    expect(html).toContain('value="expert:security"');
    expect(html).toContain("Association explicite enregistrée : Aucun expert");
  });
});
