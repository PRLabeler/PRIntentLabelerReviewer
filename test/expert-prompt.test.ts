import express from "express";
import type { Server } from "node:http";
import { once } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getGitHubOAuthService } from "../src/auth/runtime.js";
import { getExpertConfigurationService } from "../src/configuration/expert-configuration-runtime.js";
import {
  buildDefaultExpertPrompt,
  EXPERT_PROMPT_TOO_LONG_ERROR,
  ExpertPromptStore,
  getExpertPromptStore,
  MAX_EXPERT_PROMPT_LENGTH,
} from "../src/configuration/expert-prompts.js";
import { getLlmConfigurationService } from "../src/configuration/runtime.js";
import { registerConfigurationRoutes } from "../src/http/configuration-routes.js";
import { renderExpertSettingsPage } from "../src/http/expert-settings-page.js";
import type { TextGenerator } from "../src/llm/text-generator.js";
import { ConfigurableReviewExpert } from "../src/review/configurable-review-expert.js";
import { reviewContext } from "./fixtures/bug-review.js";

vi.mock("../src/auth/runtime.js", () => ({ getGitHubOAuthService: vi.fn() }));
vi.mock("../src/configuration/expert-configuration-runtime.js", () => ({
  getExpertConfigurationService: vi.fn(),
}));
vi.mock("../src/configuration/expert-prompts.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/configuration/expert-prompts.js")>();
  return {
    ...actual,
    getExpertPromptStore: vi.fn(),
  };
});
vi.mock("../src/configuration/runtime.js", () => ({
  getLlmConfigurationService: vi.fn(),
}));

const session = {
  githubUserId: 7,
  githubLogin: "test-user",
  installationIds: [42],
  csrfToken: "csrf-test",
  expiresAt: new Date(Date.now() + 100000),
};

function createInMemoryPromptStore() {
  const rows = new Map<string, { system_prompt: string; updated_at: Date }>();
  const store = new ExpertPromptStore({
    query: (async (sql: string, params: unknown[]) => {
      const installationId = params[0] as number;
      const intention = params[1] as string | undefined;
      if (sql.startsWith("SELECT")) {
        const row = rows.get(`${installationId}:${intention}`);
        return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
      }
      if (sql.startsWith("INSERT")) {
        const row = {
          system_prompt: params[2] as string,
          updated_at: new Date(),
        };
        rows.set(`${installationId}:${intention}`, row);
        return { rows: [row], rowCount: 1 };
      }
      if (sql.includes("AND intention")) {
        const deleted = rows.delete(`${installationId}:${intention}`);
        return { rows: [], rowCount: deleted ? 1 : 0 };
      }
      let count = 0;
      for (const key of rows.keys()) {
        if (key.startsWith(`${installationId}:`)) {
          rows.delete(key);
          count += 1;
        }
      }
      return { rows: [], rowCount: count };
    }) as never,
  });
  return { rows, store };
}

describe("ExpertPromptStore", () => {
  it("retourne le prompt par défaut, enregistre une personnalisation et réinitialise", async () => {
    const { store } = createInMemoryPromptStore();

    const initial = await store.getSummary(42, "bug");
    expect(initial.isCustom).toBe(false);
    expect(initial.systemPrompt).toBe(buildDefaultExpertPrompt("bug"));
    expect(await store.resolve(42, "bug")).toBeNull();

    const saved = await store.save({
      installationId: 42,
      intention: "bug",
      systemPrompt: "Line 1\r\nLine 2  ",
      githubUserId: 7,
    });
    expect(saved.isCustom).toBe(true);
    expect(saved.systemPrompt).toBe("Line 1\nLine 2");
    expect(await store.resolve(42, "bug")).toBe("Line 1\nLine 2");

    expect(await store.reset(42, "bug")).toBe(true);
    expect((await store.getSummary(42, "bug")).isCustom).toBe(false);
  });

  it("rejette les prompts vides ou trop longs", async () => {
    const { store } = createInMemoryPromptStore();

    await expect(
      store.save({
        installationId: 42,
        intention: "bug",
        systemPrompt: "   \n  ",
        githubUserId: 7,
      }),
    ).rejects.toThrow("Le prompt de l’expert est requis.");

    await expect(
      store.save({
        installationId: 42,
        intention: "bug",
        systemPrompt: "a".repeat(MAX_EXPERT_PROMPT_LENGTH + 1),
        githubUserId: 7,
      }),
    ).rejects.toThrow(EXPERT_PROMPT_TOO_LONG_ERROR);
  });
});

describe("ConfigurableReviewExpert avec prompt personnalisé", () => {
  it("envoie le prompt système personnalisé au TextGenerator", async () => {
    const generate = vi.fn(async () =>
      JSON.stringify({ summary: "OK", findings: [] }),
    );
    const generator: TextGenerator = {
      tokenBudget: { promptTokenBudget: 10000, responseReserveTokens: 1000 },
      generate,
    };
    const expert = new ConfigurableReviewExpert(
      generator,
      "Custom system prompt for bug review",
    );

    await expert.review(reviewContext(), "bug");
    expect(generate).toHaveBeenCalledWith(
      expect.objectContaining({
        system: "Custom system prompt for bug review",
      }),
    );
  });
});

describe("UI et routes de gestion du prompt expert", () => {
  let server: Server;
  let base: string;
  let promptStore: ExpertPromptStore;

  beforeEach(async () => {
    ({ store: promptStore } = createInMemoryPromptStore());
    vi.mocked(getGitHubOAuthService).mockReturnValue({
      getSession: vi.fn(async () => session),
    } as unknown as NonNullable<ReturnType<typeof getGitHubOAuthService>>);
    vi.mocked(getExpertConfigurationService).mockReturnValue({
      getSummary: vi.fn(async () => null),
    } as unknown as ReturnType<typeof getExpertConfigurationService>);
    vi.mocked(getExpertPromptStore).mockReturnValue(promptStore);
    vi.mocked(getLlmConfigurationService).mockReturnValue({
      getSummary: vi.fn(async () => null),
    } as unknown as NonNullable<ReturnType<typeof getLlmConfigurationService>>);

    const app = express();
    const router = express.Router();
    registerConfigurationRoutes(router);
    app.use(router);
    server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Server address unavailable");
    }
    base = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("affiche le prompt par défaut sans bouton de réinitialisation", () => {
    const html = renderExpertSettingsPage({
      installationId: 42,
      intention: "bug",
      session,
      configuration: null,
    });
    expect(html).toContain('name="systemPrompt"');
    expect(html).toContain("Prompt par défaut");
    expect(html).toContain("You are a code-review expert specialized in");
    expect(html).not.toContain("Réinitialiser le prompt par défaut");
  });

  it("permet de lire, modifier et réinitialiser le prompt via HTTP", async () => {
    const headers = {
      cookie: "pril_session=token",
      "content-type": "application/x-www-form-urlencoded",
    };

    const initialResponse = await fetch(`${base}/settings/42/experts/bug`, {
      headers: { cookie: headers.cookie },
      redirect: "manual",
    });
    expect(initialResponse.status).toBe(200);
    const initialHtml = await initialResponse.text();
    expect(initialHtml).toContain("Prompt par défaut");
    expect(initialHtml).toContain('action="/settings/42/experts/bug/prompt/save"');

    const saveResponse = await fetch(
      `${base}/settings/42/experts/bug/prompt/save`,
      {
        method: "POST",
        headers,
        body: new URLSearchParams({
          _csrf: session.csrfToken,
          systemPrompt: "Custom prompt <test>",
        }),
        redirect: "manual",
      },
    );
    expect(saveResponse.status).toBe(302);
    expect(saveResponse.headers.get("location")).toBe(
      "/settings/42/experts/bug?promptSaved=1#expert-prompt",
    );

    const updatedResponse = await fetch(
      `${base}/settings/42/experts/bug?promptSaved=1`,
      { headers: { cookie: headers.cookie } },
    );
    const updatedHtml = await updatedResponse.text();
    expect(updatedHtml).toContain("Prompt personnalisé");
    expect(updatedHtml).toContain("Custom prompt &lt;test&gt;");
    expect(updatedHtml).toContain("Réinitialiser le prompt par défaut");

    const invalidSave = await fetch(
      `${base}/settings/42/experts/bug/prompt/save`,
      {
        method: "POST",
        headers,
        body: new URLSearchParams({
          _csrf: session.csrfToken,
          systemPrompt: "   ",
        }),
      },
    );
    expect(invalidSave.status).toBe(400);
    expect(await invalidSave.text()).toContain("Le prompt de l’expert est requis.");

    const resetResponse = await fetch(
      `${base}/settings/42/experts/bug/prompt/reset`,
      {
        method: "POST",
        headers,
        body: new URLSearchParams({ _csrf: session.csrfToken }),
        redirect: "manual",
      },
    );
    expect(resetResponse.status).toBe(302);
    expect(resetResponse.headers.get("location")).toBe(
      "/settings/42/experts/bug?promptReset=1#expert-prompt",
    );
    expect(await promptStore.resolve(42, "bug")).toBeNull();
  });
});
