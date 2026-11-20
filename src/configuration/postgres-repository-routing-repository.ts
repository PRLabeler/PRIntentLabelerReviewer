import type { Pool, PoolClient, QueryResultRow } from "pg";
import type {
  ExpertRoutingScope,
  UnmappedLabelBehavior,
} from "../domain/expert-routing.js";
import type {
  RepositoryRoutingRepository,
  SaveRepositoryRoutingPolicy,
  StoredRepositoryRoutingPolicy,
} from "./repository-routing.js";

type PolicyRow = QueryResultRow & {
  installation_id: string;
  repository_id: string;
  default_behavior: UnmappedLabelBehavior;
  created_by_github_user_id: string | null;
  updated_by_github_user_id: string | null;
  created_at: Date;
  updated_at: Date;
  mappings: Array<{
    label_id: string;
    label_name: string;
    expert_id: string | null;
  }>;
};

// Une seule instruction lit politique et règles dans le même snapshot SQL.
const SELECT_POLICY = `SELECT policy.*,
  COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'label_id', mapping.label_id::text,
      'label_name', mapping.label_name,
      'expert_id', mapping.expert_id
    ) ORDER BY mapping.label_id)
    FROM label_expert_mappings mapping
    WHERE mapping.installation_id = policy.installation_id
      AND mapping.repository_id = policy.repository_id
  ), '[]'::jsonb) AS mappings
  FROM repository_review_policies policy
  WHERE policy.installation_id = $1 AND policy.repository_id = $2`;

function mapRow(row: PolicyRow): StoredRepositoryRoutingPolicy {
  return {
    installationId: Number(row.installation_id),
    repositoryId: Number(row.repository_id),
    defaultBehavior: row.default_behavior,
    mappings: row.mappings.map((mapping) => ({
      labelId: Number(mapping.label_id),
      labelName: mapping.label_name,
      target:
        mapping.expert_id === null
          ? { kind: "none" }
          : { kind: "expert", expertId: mapping.expert_id },
    })),
    createdByGithubUserId:
      row.created_by_github_user_id === null
        ? null
        : Number(row.created_by_github_user_id),
    updatedByGithubUserId:
      row.updated_by_github_user_id === null
        ? null
        : Number(row.updated_by_github_user_id),
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

async function readPolicy(
  client: Pick<Pool, "query"> | PoolClient,
  scope: ExpertRoutingScope,
): Promise<StoredRepositoryRoutingPolicy | null> {
  const result = await client.query<PolicyRow>(SELECT_POLICY, [
    scope.installationId,
    scope.repositoryId,
  ]);
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

async function recordAudit(
  client: PoolClient,
  action: "created" | "updated" | "deleted",
  previous: StoredRepositoryRoutingPolicy | null,
  current: StoredRepositoryRoutingPolicy | null,
  githubUserId?: number,
): Promise<void> {
  const scope = current ?? previous;
  if (!scope) throw new Error("Une politique est nécessaire pour l’audit.");
  await client.query(
    `INSERT INTO repository_review_policy_audits
      (installation_id, repository_id, action, previous_policy, new_policy, github_user_id)
     VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6)`,
    [
      scope.installationId,
      scope.repositoryId,
      action,
      previous ? JSON.stringify(previous) : null,
      current ? JSON.stringify(current) : null,
      githubUserId ?? null,
    ],
  );
}

export class PostgresRepositoryRoutingRepository implements RepositoryRoutingRepository {
  constructor(private readonly pool: Pool) {}

  findByRepository(
    scope: ExpertRoutingScope,
  ): Promise<StoredRepositoryRoutingPolicy | null> {
    return readPolicy(this.pool, scope);
  }

  async upsert(
    input: SaveRepositoryRoutingPolicy,
  ): Promise<StoredRepositoryRoutingPolicy> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const scope = [input.installationId, input.repositoryId];
      const inserted = await client.query(
        `INSERT INTO repository_review_policies
          (installation_id, repository_id, default_behavior,
           created_by_github_user_id, updated_by_github_user_id)
         VALUES ($1, $2, $3, $4, $4)
         ON CONFLICT (installation_id, repository_id) DO NOTHING
         RETURNING repository_id`,
        [...scope, input.defaultBehavior, input.githubUserId ?? null],
      );
      const created = inserted.rows.length > 0;
      let previous: StoredRepositoryRoutingPolicy | null = null;
      if (!created) {
        // Toutes les modifications des règles sont sérialisées par la ligne
        // parent. La lecture suivante voit la dernière sauvegarde validée.
        await client.query(
          `SELECT repository_id FROM repository_review_policies
           WHERE installation_id = $1 AND repository_id = $2 FOR UPDATE`,
          scope,
        );
        previous = await readPolicy(client, input);
        if (!previous)
          throw new Error(
            "La politique a été supprimée pendant la sauvegarde.",
          );
        await client.query(
          `UPDATE repository_review_policies SET default_behavior = $3,
             updated_by_github_user_id = $4, updated_at = NOW()
           WHERE installation_id = $1 AND repository_id = $2`,
          [...scope, input.defaultBehavior, input.githubUserId ?? null],
        );
      }
      await client.query(
        `DELETE FROM label_expert_mappings WHERE installation_id = $1 AND repository_id = $2`,
        scope,
      );
      if (input.mappings.length > 0) {
        const mappings = input.mappings.map((mapping) => ({
          label_id: mapping.labelId,
          label_name: mapping.labelName,
          expert_id:
            mapping.target.kind === "none" ? null : mapping.target.expertId,
        }));
        await client.query(
          `INSERT INTO label_expert_mappings
            (installation_id, repository_id, label_id, label_name, expert_id)
           SELECT $1, $2, entry.label_id, entry.label_name, entry.expert_id
           FROM jsonb_to_recordset($3::jsonb)
             AS entry(label_id bigint, label_name text, expert_id text)`,
          [...scope, JSON.stringify(mappings)],
        );
      }
      const saved = await readPolicy(client, input);
      if (!saved) throw new Error("La politique enregistrée est introuvable.");
      await recordAudit(
        client,
        created ? "created" : "updated",
        previous,
        saved,
        input.githubUserId,
      );
      await client.query("COMMIT");
      return saved;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async deleteForInstallation(
    installationId: number,
    githubUserId?: number,
  ): Promise<number> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const policies = await client.query<{ repository_id: string }>(
        `SELECT repository_id FROM repository_review_policies
         WHERE installation_id = $1 ORDER BY repository_id FOR UPDATE`,
        [installationId],
      );
      for (const row of policies.rows) {
        const scope = {
          installationId,
          repositoryId: Number(row.repository_id),
        };
        const previous = await readPolicy(client, scope);
        if (!previous)
          throw new Error("La politique à supprimer est introuvable.");
        await client.query(
          `DELETE FROM repository_review_policies WHERE installation_id = $1 AND repository_id = $2`,
          [installationId, scope.repositoryId],
        );
        await recordAudit(client, "deleted", previous, null, githubUserId);
      }
      await client.query("COMMIT");
      return policies.rows.length;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
