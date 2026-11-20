import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { PostgresRepositoryRoutingRepository } from "../src/configuration/postgres-repository-routing-repository.js";
import type { SaveRepositoryRoutingPolicy } from "../src/configuration/repository-routing.js";

const scope = { installationId: 42, repositoryId: 100 };
const mappings = [
  { label_id: "10", label_name: "bug", expert_id: "bug" },
  { label_id: "11", label_name: "question", expert_id: null },
];
const row = {
  installation_id: "42",
  repository_id: "100",
  default_behavior: "none",
  created_by_github_user_id: "7",
  updated_by_github_user_id: "8",
  created_at: new Date("2026-01-01T00:00:00Z"),
  updated_at: new Date("2026-02-01T00:00:00Z"),
  mappings,
};
const input: SaveRepositoryRoutingPolicy = {
  ...scope,
  defaultBehavior: "none",
  githubUserId: 8,
  mappings: [
    {
      labelId: 10,
      labelName: "bug",
      target: { kind: "expert", expertId: "bug" },
    },
    { labelId: 11, labelName: "question", target: { kind: "none" } },
  ],
};

function setup(
  options: {
    existing?: boolean;
    auditFails?: boolean;
    deleting?: boolean;
    empty?: boolean;
  } = {},
) {
  let saved = false;
  const client = {
    query: vi
      .fn()
      .mockImplementation(async (sql: string, parameters?: unknown[]) => {
        if (
          sql.includes("INSERT INTO repository_review_policy_audits") &&
          options.auditFails
        )
          throw new Error("Audit failed");
        if (sql.includes("INSERT INTO repository_review_policies")) {
          if (!options.existing) saved = true;
          return { rows: options.existing ? [] : [{ repository_id: "100" }] };
        }
        if (sql.includes("UPDATE repository_review_policies")) saved = true;
        if (sql.includes("ORDER BY repository_id FOR UPDATE")) {
          return {
            rows: options.deleting
              ? [{ repository_id: "100" }, { repository_id: "101" }]
              : [],
          };
        }
        if (sql.startsWith("SELECT policy.*")) {
          return {
            rows: [
              {
                ...row,
                repository_id: String(parameters?.[1] ?? 100),
                mappings: saved && options.empty ? [] : mappings,
              },
            ],
          };
        }
        return { rows: [] };
      }),
    release: vi.fn(),
  };
  const pool = { query: vi.fn(), connect: vi.fn(async () => client) };
  const repository = new PostgresRepositoryRoutingRepository(
    pool as unknown as Pool,
  );
  return { client, pool, repository };
}

describe("PostgresRepositoryRoutingRepository (client PostgreSQL simulé)", () => {
  it("lit en un snapshot, isole la portée et distingue absence, politique vide et Aucun explicite", async () => {
    const { pool, repository } = setup();
    pool.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ ...row, mappings: [] }] })
      .mockResolvedValueOnce({ rows: [row] });
    expect(
      await repository.findByRepository({
        installationId: 43,
        repositoryId: 100,
      }),
    ).toBeNull();
    expect(
      (
        await repository.findByRepository({
          installationId: 42,
          repositoryId: 101,
        })
      )?.mappings,
    ).toEqual([]);
    const found = await repository.findByRepository(scope);
    expect(found?.mappings).toEqual(input.mappings);
    expect(found?.createdAt).toEqual(row.created_at);
    expect(pool.query.mock.calls.map((call) => call[1])).toEqual([
      [43, 100],
      [42, 101],
      [42, 100],
    ]);
    expect(pool.query.mock.calls[0][0]).toContain(
      "mapping.installation_id = policy.installation_id",
    );
    expect(pool.query.mock.calls[0][0]).toContain(
      "mapping.repository_id = policy.repository_id",
    );
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it("crée politique, règles et audit dans la même transaction avec paramètres SQL", async () => {
    const { client, repository } = setup();
    const name = "bug'; DELETE FROM repository_review_policies; --";
    const saved = await repository.upsert({
      ...input,
      mappings: [{ ...input.mappings[0], labelName: name }, input.mappings[1]],
    });
    expect(saved?.repositoryId).toBe(100);
    expect(client.query.mock.calls[0]).toEqual(["BEGIN"]);
    const bulk = client.query.mock.calls.find(([sql]) =>
      sql.includes("INSERT INTO label_expert_mappings"),
    )!;
    expect(bulk[0]).not.toContain(name);
    expect(JSON.parse(bulk[1][2])).toEqual([
      { label_id: 10, label_name: name, expert_id: "bug" },
      { label_id: 11, label_name: "question", expert_id: null },
    ]);
    const audit = client.query.mock.calls.find(([sql]) =>
      sql.includes("INSERT INTO repository_review_policy_audits"),
    )!;
    expect(audit[1].slice(0, 4)).toEqual([42, 100, "created", null]);
    expect(JSON.parse(audit[1][4]).mappings[1].target).toEqual({
      kind: "none",
    });
    expect(audit[1][5]).toBe(8);
    expect(client.query).toHaveBeenLastCalledWith("COMMIT");
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("verrouille une mise à jour, remplace les règles par une liste vide et audite avant/après", async () => {
    const { client, repository } = setup({ existing: true, empty: true });
    expect(
      (await repository.upsert({ ...input, mappings: [] })).mappings,
    ).toEqual([]);
    const queries = client.query.mock.calls;
    const lock = queries.findIndex(([sql]) =>
      sql.includes("repository_id = $2 FOR UPDATE"),
    );
    const previousRead = queries.findIndex(([sql]) =>
      sql.startsWith("SELECT policy.*"),
    );
    expect(lock).toBeLessThan(previousRead);
    const update = queries.find(([sql]) =>
      sql.includes("UPDATE repository_review_policies"),
    )!;
    expect(update[0]).not.toContain("created_at");
    expect(update[0]).not.toContain("created_by_github_user_id");
    expect(update[1]).toEqual([42, 100, "none", 8]);
    expect(
      queries.find(([sql]) =>
        sql.includes("DELETE FROM label_expert_mappings"),
      )?.[1],
    ).toEqual([42, 100]);
    expect(
      queries.some(([sql]) =>
        sql.includes("INSERT INTO label_expert_mappings"),
      ),
    ).toBe(false);
    const audit = queries.find(([sql]) =>
      sql.includes("INSERT INTO repository_review_policy_audits"),
    )!;
    expect(audit[1][2]).toBe("updated");
    expect(JSON.parse(audit[1][3]).mappings).toHaveLength(2);
    expect(JSON.parse(audit[1][4]).mappings).toEqual([]);
  });

  it("annule aussi les règles si l'audit échoue et libère la connexion", async () => {
    const { client, repository } = setup({ auditFails: true });
    await expect(repository.upsert(input)).rejects.toThrow("Audit failed");
    expect(client.query).toHaveBeenLastCalledWith("ROLLBACK");
    expect(client.query).not.toHaveBeenCalledWith("COMMIT");
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("nettoie tous les dépôts de la seule installation ciblée, conserve les audits et accepte un auteur absent", async () => {
    const { client, repository } = setup({ deleting: true });
    expect(await repository.deleteForInstallation(42)).toBe(2);
    const queries = client.query.mock.calls;
    expect(queries[1][1]).toEqual([42]);
    expect(queries[1][0]).toContain("FOR UPDATE");
    expect(
      queries
        .filter(([sql]) =>
          sql.includes("DELETE FROM repository_review_policies"),
        )
        .map((call) => call[1]),
    ).toEqual([
      [42, 100],
      [42, 101],
    ]);
    const audits = queries.filter(([sql]) =>
      sql.includes("INSERT INTO repository_review_policy_audits"),
    );
    expect(audits).toHaveLength(2);
    expect(audits.map((call) => call[1].slice(0, 3))).toEqual([
      [42, 100, "deleted"],
      [42, 101, "deleted"],
    ]);
    expect(
      audits.every(
        (call) =>
          call[1][2] === "deleted" &&
          call[1][4] === null &&
          call[1][5] === null,
      ),
    ).toBe(true);
    expect(JSON.parse(audits[0][1][3]).mappings).toHaveLength(2);
    expect(client.query).toHaveBeenLastCalledWith("COMMIT");
  });

  it("rend le nettoyage vide répétable et annule tout le nettoyage en cas d'échec d'audit", async () => {
    const empty = setup();
    expect(await empty.repository.deleteForInstallation(42)).toBe(0);
    expect(await empty.repository.deleteForInstallation(42)).toBe(0);
    expect(
      empty.client.query.mock.calls.some(([sql]) =>
        sql.includes("INSERT INTO repository_review_policy_audits"),
      ),
    ).toBe(false);
    const failing = setup({ deleting: true, auditFails: true });
    await expect(failing.repository.deleteForInstallation(42)).rejects.toThrow(
      "Audit failed",
    );
    expect(failing.client.query).toHaveBeenLastCalledWith("ROLLBACK");
    expect(failing.client.query).not.toHaveBeenCalledWith("COMMIT");
    expect(failing.client.release).toHaveBeenCalledOnce();
  });
});
