import { describe, expect, it, vi } from "vitest";
import { RepositoryRoutingService } from "../src/configuration/repository-routing-service.js";
import {
  RepositoryRoutingUnavailableError,
  RepositoryRoutingValidationError,
  type ChangeRepositoryRoutingPolicyInput,
  type SaveRepositoryRoutingPolicy,
  type StoredRepositoryRoutingPolicy,
} from "../src/configuration/repository-routing.js";

const scope = { installationId: 42, repositoryId: 100 };
const input: ChangeRepositoryRoutingPolicyInput = {
  ...scope,
  defaultBehavior: "none",
  githubUserId: 7,
  mappings: [
    { labelId: 10, target: { kind: "expert", expertId: "bug" } },
    { labelId: 11, target: { kind: "none" } },
  ],
  catalog: {
    repository: { id: 100, name: "repo", owner: "org" },
    labels: [
      { id: 10, name: "bug", description: "Corrige un défaut" },
      { id: 11, name: "question", description: null },
    ],
  },
};

function setup() {
  const rows = new Map<string, StoredRepositoryRoutingPolicy>();
  const repository = {
    findByRepository: vi.fn(
      async (scope: { installationId: number; repositoryId: number }) =>
        rows.get(`${scope.installationId}:${scope.repositoryId}`) ?? null,
    ),
    upsert: vi.fn(async (input: SaveRepositoryRoutingPolicy) => {
      const key = `${input.installationId}:${input.repositoryId}`;
      const previous = rows.get(key);
      const stored: StoredRepositoryRoutingPolicy = {
        installationId: input.installationId,
        repositoryId: input.repositoryId,
        defaultBehavior: input.defaultBehavior,
        mappings: structuredClone(input.mappings),
        createdAt: previous?.createdAt ?? new Date(),
        updatedAt: new Date(),
        createdByGithubUserId:
          previous?.createdByGithubUserId ?? input.githubUserId ?? null,
        updatedByGithubUserId: input.githubUserId ?? null,
      };
      rows.set(key, stored);
      return stored;
    }),
    deleteForInstallation: vi.fn(async () => 0),
  };
  return { repository, service: new RepositoryRoutingService(repository) };
}

describe("RepositoryRoutingService", () => {
  it("isole les portées, complète les correspondances et ne supprime pas Aucun par omission", async () => {
    const { service, repository } = setup();
    expect(await service.getPolicy(scope)).toBeNull();
    await service.save(input);
    await service.save({ ...input, installationId: 43 });
    await service.save({
      ...input,
      repositoryId: 101,
      catalog: {
        ...input.catalog,
        repository: { ...input.catalog.repository, id: 101 },
      },
    });
    const saved = await service.getPolicy(scope);
    expect(saved?.defaultBehavior).toBe("general");
    expect(saved?.mappings[1].target).toEqual({ kind: "none" });
    expect(saved?.mappings.some((mapping) => mapping.labelId === 99)).toBe(
      false,
    );
    await service.save({ ...input, mappings: [] });
    expect((await service.getPolicy(scope))?.mappings).toEqual(saved?.mappings);
    repository.findByRepository.mockResolvedValueOnce({
      ...saved!,
      mappings: [],
    });
    expect((await service.getPolicy(scope))?.mappings).toEqual([]);
    expect(
      (await service.getPolicy({ ...scope, installationId: 43 }))?.mappings,
    ).toHaveLength(2);
    expect(
      (await service.getPolicy({ ...scope, repositoryId: 101 }))?.mappings,
    ).toHaveLength(2);
  });

  it("actualise un nom par identifiant et conserve les règles orphelines sans les transférer à un nouveau label", async () => {
    const { service, repository } = setup();
    await service.save(input);
    const renamedCatalog = {
      ...input.catalog,
      labels: [
        { id: 10, name: "correctness", description: null },
        { id: 11, name: "question", description: null },
      ],
    };
    expect(
      (await service.save({ ...input, catalog: renamedCatalog })).mappings[0]
        .labelName,
    ).toBe("correctness");
    const recreatedCatalog = {
      ...input.catalog,
      labels: [{ id: 50, name: "bug", description: null }],
    };
    const saved = await service.save({ ...input, catalog: recreatedCatalog });
    expect(saved.mappings.map((mapping) => mapping.labelId)).toEqual([
      10, 11, 50,
    ]);
    expect(saved.mappings[2].target).toEqual({
      kind: "expert",
      expertId: "general",
    });
    expect(saved.mappings[0].labelName).toBe("correctness");
    const writes = repository.upsert.mock.calls.length;
    await service.getPolicy(scope);
    expect(repository.upsert).toHaveBeenCalledTimes(writes);
    await expect(
      service.save({
        ...input,
        catalog: recreatedCatalog,
        mappings: [
          { labelId: 999, target: { kind: "expert", expertId: "bug" } },
        ],
      }),
    ).rejects.toBeInstanceOf(RepositoryRoutingValidationError);
  });

  it("accepte Général du registre comme cible sans exiger de configuration LLM", async () => {
    const { service } = setup();
    const saved = await service.save({
      ...input,
      githubUserId: undefined,
      defaultBehavior: "general",
      mappings: [
        { labelId: 10, target: { kind: "expert", expertId: "general" } },
        { labelId: 11, target: { kind: "none" } },
      ],
    });
    expect(saved.defaultBehavior).toBe("general");
    expect(saved.mappings[0].target).toEqual({
      kind: "expert",
      expertId: "general",
    });
    expect(saved.updatedByGithubUserId).toBeNull();
  });

  it("refuse les règles ambiguës, les experts inconnus et un catalogue d'un autre dépôt avant écriture", async () => {
    const { service, repository } = setup();
    const invalidInputs: ChangeRepositoryRoutingPolicyInput[] = [
      { ...input, mappings: [input.mappings[0], input.mappings[0]] },
      {
        ...input,
        mappings: [
          { labelId: 10, target: { kind: "expert", expertId: "unknown" } },
        ],
      },
      { ...input, repositoryId: 999 },
    ];
    for (const invalid of invalidInputs) {
      await expect(service.save(invalid)).rejects.toBeInstanceOf(
        RepositoryRoutingValidationError,
      );
    }
    expect(repository.upsert).not.toHaveBeenCalled();
  });

  it("ne confond jamais une panne avec une politique absente et masque les détails SQL", async () => {
    const { service, repository } = setup();
    repository.findByRepository.mockRejectedValue(
      new Error("fake-sensitive-sql-detail"),
    );
    await expect(service.getPolicy(scope)).rejects.toBeInstanceOf(
      RepositoryRoutingUnavailableError,
    );
    await expect(service.save(input)).rejects.toThrow(
      "service de configuration du routage",
    );
    expect(repository.upsert).not.toHaveBeenCalled();
    repository.findByRepository.mockResolvedValue(null);
    repository.upsert.mockRejectedValue(new Error("fake-sensitive-sql-detail"));
    await expect(service.save(input)).rejects.toThrow(
      "service de configuration du routage",
    );
    repository.deleteForInstallation.mockRejectedValue(
      new Error("fake-sensitive-sql-detail"),
    );
    await expect(service.deleteForInstallation(42)).rejects.toBeInstanceOf(
      RepositoryRoutingUnavailableError,
    );
  });
});
