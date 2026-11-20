import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { handlePullRequestEvent } from "../src/handlers/pull-request-handler.js";
import type { LlmProvider } from "../src/llm/llm-provider.js";
import { toAiLabelName } from "../src/labels/ai-label-name.js";
import type { ReviewExpert } from "../src/review/review-expert.js";
import type { Pool } from "pg";
import { getExpertConfigurationService } from "../src/configuration/expert-configuration-runtime.js";
import { ExpertConfigurationService } from "../src/configuration/expert-configuration-service.js";
import { PostgresExpertConfigurationRepository } from "../src/configuration/postgres-expert-configuration-repository.js";
import { getRepositoryRoutingService } from "../src/configuration/repository-routing-runtime.js";
import { RepositoryRoutingService } from "../src/configuration/repository-routing-service.js";
import type { StoredRepositoryRoutingPolicy } from "../src/configuration/repository-routing.js";
import { ApiKeyCipher } from "../src/security/api-key-cipher.js";
import { providerResponse } from "./fixtures/bug-review.js";

vi.mock("../src/configuration/expert-configuration-runtime.js", () => ({
  getExpertConfigurationService: vi.fn(),
}));
vi.mock("../src/configuration/repository-routing-runtime.js", () => ({
  getRepositoryRoutingService: vi.fn(),
}));

const resolveExpertConfiguration = vi.fn();
const findRoutingPolicy = vi.fn();

function storedRoutingPolicy(
  overrides: Partial<StoredRepositoryRoutingPolicy> = {},
): StoredRepositoryRoutingPolicy {
  return {
    installationId: 42,
    repositoryId: 123,
    defaultBehavior: "none",
    mappings: [],
    createdByGithubUserId: null,
    updatedByGithubUserId: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

function createMockContext() {
  return {
    payload: {
      action: "opened",
      installation: { id: 42 },
      pull_request: {
        number: 7,
        title: "Add JWT auth",
        body: "",
        user: { login: "talip" },
        base: { ref: "main" },
        head: { ref: "feat/jwt", sha: "sha-jwt" },
        html_url: "",
        additions: 30,
        deletions: 2,
        changed_files: 1,
      },
      repository: { id: 123, owner: { login: "org" }, name: "repo" },
    },
    octokit: {
      pulls: {
        listReviewComments: vi.fn().mockResolvedValue({ data: [] }),
        createReview: vi.fn().mockResolvedValue({}),
        listFiles: vi.fn().mockResolvedValue({
          data: [
            {
              filename: "src/auth/jwt.ts",
              status: "added",
              additions: 30,
              deletions: 0,
              changes: 30,
            },
          ],
        }),
      },
      issues: {
        listLabelsForRepo: vi.fn().mockResolvedValue({
          data: [
            { id: 10, name: "feature" },
            { id: 11, name: "bug" },
            { id: 12, name: "enhancement" },
          ],
        }),
        listLabelsOnIssue: vi.fn().mockResolvedValue({ data: [] }),
        listComments: vi.fn().mockResolvedValue({ data: [] }),
        createComment: vi.fn().mockResolvedValue({}),
        updateComment: vi.fn().mockResolvedValue({}),
        addLabels: vi.fn().mockResolvedValue({}),
        removeLabel: vi.fn().mockResolvedValue({}),
        createLabel: vi.fn().mockResolvedValue({}),
        getLabel: vi.fn().mockResolvedValue({ data: { color: "d73a4a" } }),
      },
      checks: {
        create: vi.fn().mockResolvedValue({}),
      },
    },
    log: {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    },
  };
}

function mockProvider(): LlmProvider {
  return {
    classifyPullRequest: vi.fn().mockResolvedValue({
      suggestions: [
        { name: "feature", confidence: 0.95, reason: "nouvel endpoint" },
        { name: "bug", confidence: 0.72, reason: "corrige un cas limite" },
      ],
      summary: "Ajoute l'authentification JWT.",
    }),
  };
}

describe("handlePullRequestEvent — chemin LLM", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveExpertConfiguration.mockReset().mockResolvedValue(null);
    vi.mocked(getExpertConfigurationService)
      .mockReset()
      .mockReturnValue({
        resolve: resolveExpertConfiguration,
      } as unknown as ExpertConfigurationService);
    findRoutingPolicy.mockReset().mockResolvedValue(null);
    vi.mocked(getRepositoryRoutingService)
      .mockReset()
      .mockReturnValue(
        new RepositoryRoutingService({
          findByRepository: findRoutingPolicy,
          upsert: vi.fn(),
          deleteForInstallation: vi.fn(),
        }),
      );
    vi.stubEnv("GEMINI_REVIEW_API_KEY", "");
    vi.stubEnv("GEMINI_API_KEY", "");
    delete process.env.LABEL_MODE;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    delete process.env.LABEL_MODE;
  });

  it("mode suggest : commente sans appliquer de label", async () => {
    process.env.LABEL_MODE = "suggest";
    const ctx = createMockContext();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handlePullRequestEvent(ctx as any, mockProvider());

    expect(ctx.octokit.issues.createComment).toHaveBeenCalled();
    expect(ctx.octokit.issues.addLabels).not.toHaveBeenCalled();
  });

  it("mode auto-high : applique les labels au-dessus du seuil et retire les autres suggérés", async () => {
    process.env.LABEL_MODE = "auto-high";
    const ctx = createMockContext();
    ctx.octokit.issues.listLabelsOnIssue = vi
      .fn()
      .mockResolvedValue({ data: [{ name: toAiLabelName("bug") }] });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handlePullRequestEvent(ctx as any, mockProvider());

    expect(ctx.octokit.issues.removeLabel).toHaveBeenCalledWith(
      expect.objectContaining({ name: toAiLabelName("bug") }),
    );
    expect(ctx.octokit.issues.addLabels).toHaveBeenCalledWith(
      expect.objectContaining({ labels: [toAiLabelName("feature")] }),
    );
  });

  it("mode auto-all : applique tous les labels retenus, préfixés par l'icône IA", async () => {
    process.env.LABEL_MODE = "auto-all";
    const ctx = createMockContext();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handlePullRequestEvent(ctx as any, mockProvider());

    expect(ctx.octokit.issues.addLabels).toHaveBeenCalledWith(
      expect.objectContaining({
        labels: [toAiLabelName("feature"), toAiLabelName("bug")],
      }),
    );
  });

  it("mode suggest : ne crée ni n'applique aucun label", async () => {
    process.env.LABEL_MODE = "suggest";
    const ctx = createMockContext();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handlePullRequestEvent(ctx as any, mockProvider());

    expect(ctx.octokit.issues.addLabels).not.toHaveBeenCalled();
    expect(ctx.octokit.issues.createLabel).not.toHaveBeenCalled();
  });

  it("ne plante pas si l'application des labels échoue", async () => {
    process.env.LABEL_MODE = "auto-all";
    const ctx = createMockContext();
    ctx.octokit.issues.addLabels = vi
      .fn()
      .mockRejectedValue(new Error("403 Forbidden"));

    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      handlePullRequestEvent(ctx as any, mockProvider()),
    ).resolves.not.toThrow();

    expect(ctx.octokit.issues.createComment).toHaveBeenCalled();
  });

  it("rejette un label existant dans le dépôt mais absent du catalogue envoyé au LLM", async () => {
    process.env.LABEL_MODE = "auto-all";
    const ctx = createMockContext();
    ctx.octokit.issues.listLabelsForRepo = vi.fn().mockResolvedValue({
      data: Array.from({ length: 31 }, (_, index) => ({
        name: `custom-label-${index + 1}`,
      })),
    });
    const provider: LlmProvider = {
      classifyPullRequest: vi.fn().mockResolvedValue({
        suggestions: [
          {
            name: "custom-label-31",
            confidence: 0.99,
            reason: "Not shown to the model",
          },
        ],
        summary: "Summary.",
      }),
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handlePullRequestEvent(ctx as any, provider);

    expect(provider.classifyPullRequest).toHaveBeenCalled();
    expect(ctx.octokit.issues.addLabels).not.toHaveBeenCalled();
    expect(findRoutingPolicy).not.toHaveBeenCalled();
  });

  it("n'appelle pas le LLM lorsqu'aucun label candidat n'est disponible", async () => {
    const ctx = createMockContext();
    ctx.octokit.issues.listLabelsForRepo = vi
      .fn()
      .mockResolvedValue({ data: [] });
    const provider = mockProvider();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handlePullRequestEvent(ctx as any, provider);

    expect(provider.classifyPullRequest).not.toHaveBeenCalled();
    expect(ctx.octokit.issues.createComment).toHaveBeenCalled();
    expect(findRoutingPolicy).not.toHaveBeenCalled();
  });

  it("achemine une PR classée bug vers l'expert spécialisé", async () => {
    const ctx = createMockContext();
    const classifier: LlmProvider = {
      classifyPullRequest: vi.fn().mockResolvedValue({
        suggestions: [
          { name: "bug", confidence: 0.95, reason: "corrige un crash" },
        ],
        summary: "Corrige un crash.",
      }),
    };
    const expert: ReviewExpert = {
      review: vi.fn().mockResolvedValue({
        intent: "bug",
        verdict: "approved",
        summary: "La correction est valide.",
        findings: [],
      }),
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handlePullRequestEvent(ctx as any, classifier, expert);

    expect(expert.review).toHaveBeenCalledWith(expect.any(Object), "bug");
    expect(findRoutingPolicy).toHaveBeenCalledOnce();
    expect(findRoutingPolicy).toHaveBeenCalledWith({
      installationId: 42,
      repositoryId: 123,
    });
    expect(ctx.log.info).toHaveBeenCalledWith(
      expect.objectContaining({ routingMode: "legacy", expertId: "bug" }),
      "Review routing resolved",
    );
    expect(ctx.octokit.issues.createComment).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.stringContaining("Verdict : correction validée"),
      }),
    );
  });

  it.each([
    { intention: "bug", label: "bug", configured: false },
    { intention: "feature", label: "enhancement", configured: true },
  ])(
    "route $label vers $intention jusqu'au modèle PostgreSQL et aux commentaires inline",
    async ({ intention, label, configured }) => {
      const ctx = createMockContext();
      if (configured) {
        findRoutingPolicy.mockResolvedValue(
          storedRoutingPolicy({
            mappings: [
              {
                labelId: 12,
                labelName: "ancien-nom-du-label",
                target: { kind: "expert", expertId: "feature" },
              },
              {
                labelId: 11,
                labelName: "bug",
                target: { kind: "expert", expertId: "bug" },
              },
            ],
          }),
        );
      }
      ctx.octokit.pulls.listFiles.mockResolvedValue({
        data: [
          {
            filename: "src/auth/jwt.ts",
            status: "added",
            additions: 1,
            deletions: 0,
            changes: 1,
            patch: "@@ -0,0 +1 @@\n+export const token = null;",
          },
        ],
      });
      const classifier: LlmProvider = {
        classifyPullRequest: vi.fn().mockResolvedValue({
          // L'ordre brut est inversé pour vérifier la sélection principale.
          suggestions: [
            {
              name: intention === "bug" ? "feature" : "bug",
              confidence: 0.8,
              reason: "secondaire",
            },
            { name: label, confidence: 0.96, reason: "principale" },
          ],
          summary: "Analyse terminée.",
        }),
      };
      const apiKey = "fake-persisted-expert-key";
      const cipher = new ApiKeyCipher(Buffer.alloc(32, 5).toString("base64"));
      const encryptedKey = cipher.encrypt(apiKey);
      const storedRow = {
        installation_id: "42",
        provider: "anthropic",
        model: `selected-${intention}-model`,
        encrypted_api_key: encryptedKey.ciphertext,
        encryption_iv: encryptedKey.iv,
        encryption_auth_tag: encryptedKey.authTag,
        key_last_four: "-key",
        base_url: null,
        created_by_github_user_id: "7",
        updated_by_github_user_id: "7",
        created_at: new Date(),
        updated_at: new Date(),
      };
      const query = vi.fn().mockResolvedValue({ rows: [storedRow] });
      const service = new ExpertConfigurationService(
        (requestedIntention) =>
          new PostgresExpertConfigurationRepository(
            { query } as unknown as Pool,
            requestedIntention,
          ),
        cipher,
      );
      vi.mocked(getExpertConfigurationService).mockReturnValue(service);
      vi.stubEnv("GEMINI_REVIEW_API_KEY", "fake-environment-key");
      const fetchMock = vi.fn(async () =>
        providerResponse(
          "anthropic",
          JSON.stringify({
            summary: "Un défaut vérifiable.",
            findings: [
              {
                file: "src/auth/jwt.ts",
                startLine: 1,
                endLine: 1,
                severity: "error",
                message: "Le jeton est absent.",
                suggestion: "Initialiser le jeton.",
              },
            ],
          }),
          true,
        ),
      );
      vi.stubGlobal("fetch", fetchMock);

      // Résolveur, service, déchiffrement, factory et adaptateur réels.
      // Seuls PostgreSQL et les clients HTTP sont simulés.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await handlePullRequestEvent(ctx as any, classifier);

      expect(query).toHaveBeenCalledOnce();
      expect(findRoutingPolicy).toHaveBeenCalledOnce();
      expect(findRoutingPolicy).toHaveBeenCalledWith({
        installationId: 42,
        repositoryId: 123,
      });
      expect(query).toHaveBeenCalledWith(
        expect.stringContaining(
          "WHERE installation_id = $1 AND intention = $2",
        ),
        [42, intention],
      );
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(fetchMock).toHaveBeenCalledWith(
        "https://api.anthropic.com/v1/messages",
        expect.objectContaining({
          headers: expect.objectContaining({ "x-api-key": apiKey }),
          body: expect.stringContaining(
            `"model":"selected-${intention}-model"`,
          ),
        }),
      );
      expect(ctx.octokit.pulls.createReview).toHaveBeenCalledWith(
        expect.objectContaining({
          event: "REQUEST_CHANGES",
          commit_id: "sha-jwt",
          comments: [
            expect.objectContaining({
              path: "src/auth/jwt.ts",
              line: 1,
              side: "RIGHT",
              body: expect.stringContaining(`intent=${intention} sha=sha-jwt`),
            }),
          ],
        }),
      );
      expect(ctx.log.info).toHaveBeenCalledWith(
        expect.objectContaining({
          installationId: 42,
          repositoryId: 123,
          routingMode: configured ? "configured" : "legacy",
          expertId: intention,
          triggeringLabels: [
            expect.objectContaining({
              labelId: configured ? 12 : 11,
              name: label,
              confidence: 0.96,
              source: configured ? "explicit" : "legacy",
            }),
          ],
          provider: "anthropic",
          model: storedRow.model,
          source: "installation",
        }),
        "Review configuration selected",
      );
      expect(ctx.log.info).toHaveBeenCalledWith(
        expect.objectContaining({
          intention,
          provider: "Anthropic",
          model: storedRow.model,
        }),
        "Expert token usage measured",
      );
      const publicOutput = JSON.stringify([
        ctx.log.info.mock.calls,
        ctx.log.warn.mock.calls,
        ctx.log.error.mock.calls,
        ctx.octokit.issues.createComment.mock.calls,
        ctx.octokit.pulls.createReview.mock.calls,
      ]);
      expect(publicOutput).not.toContain(apiKey);
      expect(publicOutput).not.toContain(encryptedKey.ciphertext);
      expect(ctx.log.error).not.toHaveBeenCalled();
    },
  );

  it("ne choisit ni Gemini ni un autre expert après une panne de configuration de l'expert sélectionné", async () => {
    const ctx = createMockContext();
    findRoutingPolicy.mockResolvedValue(
      storedRoutingPolicy({
        mappings: [
          {
            labelId: 10,
            labelName: "feature",
            target: { kind: "expert", expertId: "refactor" },
          },
          {
            labelId: 11,
            labelName: "bug",
            target: { kind: "expert", expertId: "bug" },
          },
        ],
      }),
    );
    resolveExpertConfiguration.mockRejectedValue(
      new Error("fake-secret-in-db-error"),
    );
    vi.stubEnv("GEMINI_REVIEW_API_KEY", "fake-fallback-key");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handlePullRequestEvent(ctx as any, mockProvider());

    expect(resolveExpertConfiguration).toHaveBeenCalledOnce();
    expect(resolveExpertConfiguration).toHaveBeenCalledWith(42, "refactor");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(ctx.octokit.pulls.createReview).not.toHaveBeenCalled();
    expect(ctx.octokit.issues.createComment).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.stringContaining(
          "configuration de l'expert de revue est indisponible",
        ),
      }),
    );
    expect(JSON.stringify(ctx.log.warn.mock.calls)).not.toContain(
      "fake-secret",
    );
    expect(ctx.log.error).not.toHaveBeenCalled();
  });

  it("route les labels sans règle vers Général même avec une ancienne politique vide et utilise le repli Gemini", async () => {
    const ctx = createMockContext();
    findRoutingPolicy.mockResolvedValue(storedRoutingPolicy());
    vi.stubEnv("GEMINI_REVIEW_API_KEY", "fake-fallback-key");
    vi.stubEnv("GEMINI_REVIEW_MODEL", "fallback-general-model");
    const fetchMock = vi.fn(async () =>
      providerResponse("gemini", '{"summary":"Aucun défaut.","findings":[]}'),
    );
    vi.stubGlobal("fetch", fetchMock);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handlePullRequestEvent(ctx as any, mockProvider());

    expect(resolveExpertConfiguration).toHaveBeenCalledOnce();
    expect(resolveExpertConfiguration).toHaveBeenCalledWith(42, "general");
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/models/fallback-general-model:generateContent"),
      expect.any(Object),
    );
    expect(ctx.octokit.pulls.createReview).not.toHaveBeenCalled();
    expect(ctx.octokit.issues.createComment).toHaveBeenCalled();
    expect(ctx.log.info).toHaveBeenCalledWith(
      expect.objectContaining({
        expertId: "general",
        routingMode: "configured",
        routingSource: "default",
        triggeringLabels: expect.arrayContaining([
          expect.objectContaining({ labelId: 10, name: "feature" }),
        ]),
        provider: "gemini",
        model: "fallback-general-model",
        source: "environment",
      }),
      "Review configuration selected",
    );
    expect(JSON.stringify(ctx.log.info.mock.calls)).not.toContain(
      "fake-fallback-key",
    );
  });

  it("respecte les choix Aucun explicites sans revenir au routage historique ou à Général", async () => {
    const policy = storedRoutingPolicy({
      defaultBehavior: "none",
      mappings: [
        { labelId: 10, labelName: "feature", target: { kind: "none" } },
        { labelId: 11, labelName: "bug", target: { kind: "none" } },
      ],
    });
    const ctx = createMockContext();
    findRoutingPolicy.mockResolvedValue(policy);
    const expert: ReviewExpert = { review: vi.fn() };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handlePullRequestEvent(ctx as any, mockProvider(), expert);

    expect(expert.review).not.toHaveBeenCalled();
    expect(resolveExpertConfiguration).not.toHaveBeenCalled();
    expect(ctx.octokit.pulls.createReview).not.toHaveBeenCalled();
    expect(ctx.octokit.issues.createComment).toHaveBeenCalled();
    expect(ctx.log.warn).not.toHaveBeenCalled();
    expect(ctx.log.info).toHaveBeenCalledWith(
      expect.objectContaining({ routingMode: "configured", expertId: null }),
      "Review routing resolved",
    );
  });

  it.each([
    {
      name: "une panne PostgreSQL",
      error: new Error("fake-secret-in-db-error"),
      message: "Le service de configuration du routage est indisponible.",
    },
    {
      name: "une migration 003 absente",
      error: Object.assign(new Error("fake-secret-in-db-error"), {
        code: "42P01",
      }),
      message: "La migration 003 est requise",
    },
  ])(
    "suspend la revue après $name sans empêcher l'analyse et les labels",
    async ({ error, message }) => {
      const ctx = createMockContext();
      const classifier = mockProvider();
      const expert: ReviewExpert = { review: vi.fn() };
      findRoutingPolicy.mockRejectedValue(error);
      process.env.LABEL_MODE = "auto-all";
      vi.stubEnv("GEMINI_REVIEW_API_KEY", "fake-fallback-key");
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await handlePullRequestEvent(ctx as any, classifier, expert);

      expect(classifier.classifyPullRequest).toHaveBeenCalledOnce();
      expect(findRoutingPolicy).toHaveBeenCalledOnce();
      expect(expert.review).not.toHaveBeenCalled();
      expect(resolveExpertConfiguration).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(ctx.octokit.pulls.createReview).not.toHaveBeenCalled();
      expect(ctx.octokit.issues.addLabels).toHaveBeenCalledWith(
        expect.objectContaining({
          labels: [toAiLabelName("feature"), toAiLabelName("bug")],
        }),
      );
      expect(ctx.octokit.issues.createComment).toHaveBeenCalledWith(
        expect.objectContaining({ body: expect.stringContaining(message) }),
      );
      expect(ctx.octokit.issues.createComment).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.stringContaining("La revue de code n'a pas abouti"),
        }),
      );
      expect(ctx.octokit.checks.create).toHaveBeenCalled();
      expect(ctx.log.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          installationId: 42,
          repositoryId: 123,
          error: expect.stringContaining(message),
        }),
        "Review routing failed; review skipped",
      );
      expect(ctx.log.info).not.toHaveBeenCalledWith(
        expect.anything(),
        "Review routing resolved",
      );
      const publicOutput = JSON.stringify([
        ctx.log.info.mock.calls,
        ctx.log.warn.mock.calls,
        ctx.log.error.mock.calls,
        ctx.octokit.issues.createComment.mock.calls,
      ]);
      expect(publicOutput).not.toContain("fake-secret");
      expect(publicOutput).not.toContain("fake-fallback-key");
      expect(ctx.log.error).not.toHaveBeenCalled();
    },
  );

  it("privilégie une association explicite sur un label plus confiant utilisant Général par défaut", async () => {
    const ctx = createMockContext();
    findRoutingPolicy.mockResolvedValue(
      storedRoutingPolicy({
        defaultBehavior: "general",
        mappings: [
          {
            labelId: 11,
            labelName: "bug",
            target: { kind: "expert", expertId: "refactor" },
          },
        ],
      }),
    );
    const expert: ReviewExpert = {
      review: vi.fn().mockResolvedValue({
        intent: "refactor",
        verdict: "approved",
        summary: "La refactorisation est valide.",
        findings: [],
      }),
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handlePullRequestEvent(ctx as any, mockProvider(), expert);

    expect(expert.review).toHaveBeenCalledOnce();
    expect(expert.review).toHaveBeenCalledWith(expect.any(Object), "refactor");
    expect(ctx.log.info).toHaveBeenCalledWith(
      expect.objectContaining({
        expertId: "refactor",
        routingSource: "explicit",
        confidence: 0.72,
        triggeringLabels: [
          expect.objectContaining({ labelId: 11, name: "bug" }),
        ],
      }),
      "Review routing resolved",
    );
  });

  it("n'appelle pas l'expert quand le classifieur retient un label sans revue", async () => {
    const ctx = createMockContext();
    const classifier: LlmProvider = {
      classifyPullRequest: vi.fn().mockResolvedValue({
        suggestions: [
          { name: "enhancement", confidence: 0.95, reason: "nouvel endpoint" },
        ],
        summary: "Ajoute un endpoint.",
      }),
    };
    const expert: ReviewExpert = {
      review: vi.fn(),
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handlePullRequestEvent(ctx as any, classifier, expert);

    expect(expert.review).not.toHaveBeenCalled();
  });
});
