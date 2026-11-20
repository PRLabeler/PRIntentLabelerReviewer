import { getDatabasePool } from "../database/pool.js";
import { PostgresRepositoryRoutingRepository } from "./postgres-repository-routing-repository.js";
import { RepositoryRoutingService } from "./repository-routing-service.js";
import { RepositoryRoutingUnavailableError } from "./repository-routing.js";

let service: RepositoryRoutingService | undefined;

export function getRepositoryRoutingService(): RepositoryRoutingService {
  if (service) return service;
  try {
    const pool = getDatabasePool();
    if (!pool) throw new RepositoryRoutingUnavailableError();
    service = new RepositoryRoutingService(
      new PostgresRepositoryRoutingRepository(pool),
    );
    return service;
  } catch {
    throw new RepositoryRoutingUnavailableError();
  }
}

export function resetRepositoryRoutingServiceForTests(): void {
  service = undefined;
}
