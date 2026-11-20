import type { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDatabasePool } from "../src/database/pool.js";
import {
  getRepositoryRoutingService,
  resetRepositoryRoutingServiceForTests,
} from "../src/configuration/repository-routing-runtime.js";
import { RepositoryRoutingUnavailableError } from "../src/configuration/repository-routing.js";

vi.mock("../src/database/pool.js", () => ({ getDatabasePool: vi.fn() }));
beforeEach(() => {
  resetRepositoryRoutingServiceForTests();
  vi.mocked(getDatabasePool).mockReset();
});
afterEach(() => {
  resetRepositoryRoutingServiceForTests();
  vi.unstubAllEnvs();
});

describe("runtime du routage", () => {
  it("réutilise le pool sans clé LLM et sans cache des politiques", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    vi.stubEnv("CONFIG_ENCRYPTION_KEY", "");
    vi.mocked(getDatabasePool).mockReturnValue({ query } as unknown as Pool);
    const service = getRepositoryRoutingService();
    expect(getRepositoryRoutingService()).toBe(service);
    expect(query).not.toHaveBeenCalled();
    const scope = { installationId: 42, repositoryId: 100 };
    expect(await service.getPolicy(scope)).toBeNull();
    expect(await service.getPolicy(scope)).toBeNull();
    expect(query).toHaveBeenCalledTimes(2);
    query.mockRejectedValue(new Error("fake-sensitive-detail"));
    await expect(service.getPolicy(scope)).rejects.toBeInstanceOf(
      RepositoryRoutingUnavailableError,
    );
  });

  it("signale une base absente ou en erreur et permet une initialisation ultérieure", () => {
    vi.mocked(getDatabasePool)
      .mockReturnValueOnce(null)
      .mockImplementationOnce(() => {
        throw new Error("fake-sensitive-db-url");
      })
      .mockReturnValue({ query: vi.fn() } as unknown as Pool);
    expect(() => getRepositoryRoutingService()).toThrow(
      RepositoryRoutingUnavailableError,
    );
    expect(() => getRepositoryRoutingService()).toThrow(
      "service de configuration du routage",
    );
    expect(() => getRepositoryRoutingService()).not.toThrow();
  });
});
