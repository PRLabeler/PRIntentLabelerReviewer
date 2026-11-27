import type { Pool, QueryResultRow } from "pg";
import { getDatabasePool } from "../database/pool.js";
import { getExpertPolicy } from "../review/expert-policies.js";
import { buildReviewSystemPrompt } from "../review/review-prompt.js";
import {
  assertExpertIntention,
  type ExpertIntention,
} from "./expert-definitions.js";

export const MAX_EXPERT_PROMPT_LENGTH = 16000;
export const EXPERT_PROMPT_TOO_LONG_ERROR =
  "Le prompt de l’expert est trop long, il doit être moins de " +
  MAX_EXPERT_PROMPT_LENGTH +
  " caractères.";

export type ExpertPromptSummary = {
  installationId: number;
  intention: ExpertIntention;
  systemPrompt: string;
  isCustom: boolean;
  updatedAt?: Date;
};

type PromptRow = QueryResultRow & {
  system_prompt: string;
  updated_at: Date;
};

function assertPositiveId(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error("L’identifiant GitHub doit être un entier positif.");
  }
}

function normalizePrompt(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("Le prompt de l’expert est requis.");
  }
  const normalized = value.replaceAll("\r\n", "\n").trim();
  if (!normalized) {
    throw new Error("Le prompt de l’expert est requis.");
  }
  if (normalized.length > MAX_EXPERT_PROMPT_LENGTH) {
    throw new Error(EXPERT_PROMPT_TOO_LONG_ERROR);
  }
  return normalized;
}

export function buildDefaultExpertPrompt(intention: ExpertIntention): string {
  const policy = getExpertPolicy(String(intention));
  if (!policy) {
    throw new Error("Cette intention n’est pas configurable.");
  }
  return buildReviewSystemPrompt(policy);
}

export class ExpertPromptStore {
  constructor(private readonly pool: Pick<Pool, "query">) { }

  async getSummary(
    installationId: number,
    intention: ExpertIntention,
  ): Promise<ExpertPromptSummary> {
    assertPositiveId(installationId);
    assertExpertIntention(intention);
    const result = await this.pool.query<PromptRow>(
      `SELECT system_prompt, updated_at FROM expert_prompt_configurations
       WHERE installation_id = $1 AND intention = $2`,
      [installationId, intention],
    );
    const row = result.rows[0];
    if (!row) {
      return {
        installationId,
        intention,
        systemPrompt: buildDefaultExpertPrompt(intention),
        isCustom: false,
      };
    }
    return {
      installationId,
      intention,
      systemPrompt: row.system_prompt,
      isCustom: true,
      updatedAt: new Date(row.updated_at),
    };
  }

  async resolve(
    installationId: number,
    intention: ExpertIntention,
  ): Promise<string | null> {
    assertPositiveId(installationId);
    assertExpertIntention(intention);
    const result = await this.pool.query<{ system_prompt: string }>(
      `SELECT system_prompt FROM expert_prompt_configurations
       WHERE installation_id = $1 AND intention = $2`,
      [installationId, intention],
    );
    return result.rows[0]?.system_prompt ?? null;
  }

  async save(input: {
    installationId: number;
    intention: ExpertIntention;
    systemPrompt: string;
    githubUserId: number;
  }): Promise<ExpertPromptSummary> {
    assertPositiveId(input.installationId);
    assertPositiveId(input.githubUserId);
    assertExpertIntention(input.intention);
    const systemPrompt = normalizePrompt(input.systemPrompt);
    const result = await this.pool.query<PromptRow>(
      `INSERT INTO expert_prompt_configurations
        (installation_id, intention, system_prompt, updated_by_github_user_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (installation_id, intention) DO UPDATE
       SET system_prompt = EXCLUDED.system_prompt,
           updated_by_github_user_id = EXCLUDED.updated_by_github_user_id,
           updated_at = NOW()
       RETURNING system_prompt, updated_at`,
      [input.installationId, input.intention, systemPrompt, input.githubUserId],
    );
    const row = result.rows[0];
    return {
      installationId: input.installationId,
      intention: input.intention,
      systemPrompt: row.system_prompt,
      isCustom: true,
      updatedAt: new Date(row.updated_at),
    };
  }

  async reset(
    installationId: number,
    intention: ExpertIntention,
  ): Promise<boolean> {
    assertPositiveId(installationId);
    assertExpertIntention(intention);
    const result = await this.pool.query(
      `DELETE FROM expert_prompt_configurations
       WHERE installation_id = $1 AND intention = $2`,
      [installationId, intention],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async deleteForInstallation(installationId: number): Promise<number> {
    assertPositiveId(installationId);
    const result = await this.pool.query(
      `DELETE FROM expert_prompt_configurations WHERE installation_id = $1`,
      [installationId],
    );
    return result.rowCount ?? 0;
  }
}

let store: ExpertPromptStore | null | undefined;

export function getExpertPromptStore(): ExpertPromptStore | null {
  if (store !== undefined) return store;
  const pool = getDatabasePool();
  store = pool ? new ExpertPromptStore(pool) : null;
  return store;
}

export function resetExpertPromptStoreForTests(): void {
  store = undefined;
}
