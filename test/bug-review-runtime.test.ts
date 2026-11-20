import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  resolveReviewExpert,
  resolveBugReviewExpert,
  ReviewConfigurationError,
} from "../src/review/runtime.js";
import { getExpertConfigurationService } from "../src/configuration/expert-configuration-runtime.js";
import { createReviewExpert } from "../src/review/review-expert-factory.js";
import { EXPERT_PROVIDER_NAMES } from "../src/configuration/expert-definitions.js";
import {
  providerResponse,
  reviewContext,
  reviewText,
} from "./fixtures/bug-review.js";

vi.mock("../src/configuration/expert-configuration-runtime.js", () => ({
  getExpertConfigurationService: vi.fn(),
}));
vi.mock("../src/review/review-expert-factory.js", () => ({
  createReviewExpert: vi.fn(),
}));
import { registeredIntents } from "../src/review/expert-policies.js";

const resolve = vi.fn();
const expert = { review: vi.fn() };

beforeEach(() => {
  vi.stubEnv("GEMINI_REVIEW_API_KEY", "fake-fallback-key");
  vi.stubEnv("GEMINI_API_KEY", "");
  vi.stubEnv("GEMINI_REVIEW_MODEL", "fallback-model");
  resolve.mockReset().mockResolvedValue(null);
  vi.mocked(getExpertConfigurationService)
    .mockReset()
    .mockReturnValue({ resolve } as unknown as ReturnType<
      typeof getExpertConfigurationService
    >);
  vi.mocked(createReviewExpert).mockReset().mockReturnValue(expert);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("résolution des experts configurables", () => {
  it("conserve l'entrée Bug en déléguant au résolveur commun", async () => {
    const selection = await resolveBugReviewExpert(42);
    expect(selection?.metadata.intention).toBe("bug");
    expect(selection?.expert.reviewBugFix).toBeTypeOf("function");
    expect(resolve).toHaveBeenCalledWith(42, "bug");
  });

  it("refuse une intention inconnue avant toute lecture", async () => {
    await expect(resolveReviewExpert(42, "unknown-expert")).rejects.toThrow(
      ReviewConfigurationError,
    );
    expect(getExpertConfigurationService).not.toHaveBeenCalled();
  });

  it.each([
    { installationId: 43, intention: "feature" },
    { installationId: 42, intention: "bug" },
  ])("refuse une configuration provenant d'un autre scope", async (scope) => {
    resolve.mockResolvedValue({
      ...scope,
      provider: "openai",
      model: "other-model",
      apiKey: "fake-key",
    });
    await expect(resolveReviewExpert(42, "feature")).rejects.toThrow(
      ReviewConfigurationError,
    );
    expect(createReviewExpert).not.toHaveBeenCalled();
  });

  it("exécute Général avec le moteur Gemini de repli et remonte ses tokens", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => providerResponse("gemini", reviewText, true)),
    );
    const onUsage = vi.fn();
    const selected = await resolveReviewExpert(42, "general", onUsage);
    const result = await selected!.expert.review(reviewContext(), "general");
    expect(result.intent).toBe("general");
    expect(result.findings).toHaveLength(1);
    expect(onUsage).toHaveBeenCalledOnce();
    expect(onUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "Gemini",
        model: "fallback-model",
        totalTokens: 160,
      }),
    );
  });
  it.each(
    registeredIntents().flatMap((intention) =>
      EXPERT_PROVIDER_NAMES.map((provider) => ({ intention, provider })),
    ),
  )(
    "priorise la configuration $provider de l'installation pour $intention",
    async ({ intention, provider }) => {
      const configuration = {
        installationId: 42,
        intention,
        provider,
        model: "selected-model",
        apiKey: "fake-private-key",
      };
      resolve.mockResolvedValue(configuration);
      const onUsage = vi.fn();
      const selected = await resolveReviewExpert(42, intention, onUsage);
      expect(resolve).toHaveBeenCalledWith(42, intention);
      expect(createReviewExpert).toHaveBeenCalledWith(configuration, onUsage);
      expect(selected).toEqual({
        expert,
        metadata: {
          installationId: 42,
          intention,
          provider,
          model: "selected-model",
          source: "installation",
        },
      });
      expect(JSON.stringify(selected?.metadata)).not.toContain(
        configuration.apiKey,
      );
    },
  );

  it("relit à chaque analyse et isole les installations", async () => {
    resolve.mockImplementation(async (installationId: number) => ({
      installationId,
      intention: "bug",
      provider: "openai",
      model: `model-${installationId}`,
      apiKey: "fake-key",
    }));
    expect((await resolveReviewExpert(42, "bug"))?.metadata.model).toBe(
      "model-42",
    );
    expect((await resolveReviewExpert(43, "bug"))?.metadata.model).toBe(
      "model-43",
    );
    resolve.mockResolvedValue({
      installationId: 42,
      intention: "bug",
      provider: "anthropic",
      model: "new-model",
      apiKey: "fake-new-key",
    });
    expect((await resolveReviewExpert(42, "bug"))?.metadata.model).toBe(
      "new-model",
    );
    expect(resolve).toHaveBeenCalledTimes(3);
  });

  it("utilise le repli Gemini pour Général après une lecture sans configuration", async () => {
    const selected = await resolveReviewExpert(42, "general");
    expect(selected?.metadata).toEqual({
      installationId: 42,
      intention: "general",
      provider: "gemini",
      model: "fallback-model",
      source: "environment",
    });
    expect(selected?.expert.review).toBeTypeOf("function");
    expect(createReviewExpert).not.toHaveBeenCalled();
  });

  it("ne rend pas Général disponible sans configuration ni clé serveur", async () => {
    vi.stubEnv("GEMINI_REVIEW_API_KEY", "");
    expect(await resolveReviewExpert(42, "general")).toBeNull();
  });

  it("conserve le repli GEMINI_API_KEY si la clé de revue est absente", async () => {
    vi.stubEnv("GEMINI_REVIEW_API_KEY", undefined);
    vi.stubEnv("GEMINI_API_KEY", "fake-general-key");
    expect((await resolveReviewExpert(42, "bug"))?.metadata.source).toBe(
      "environment",
    );
  });

  it("refuse tout repli après une erreur de lecture ou de construction", async () => {
    resolve.mockRejectedValueOnce(new Error("fake-secret-in-db-error"));
    await expect(resolveReviewExpert(42, "bug")).rejects.toThrow(
      ReviewConfigurationError,
    );
    expect(createReviewExpert).not.toHaveBeenCalled();
    resolve.mockResolvedValue({
      installationId: 42,
      intention: "bug",
      provider: "openai",
      model: "model",
      apiKey: "fake-key",
    });
    vi.mocked(createReviewExpert).mockImplementation(() => {
      throw new Error("fake-secret-in-constructor");
    });
    const error = await resolveReviewExpert(42, "bug").catch(
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(ReviewConfigurationError);
    expect(String(error)).not.toContain("fake-secret");
    expect(error).not.toHaveProperty("cause");
  });

  it("signale un service indisponible sans revenir à Gemini", async () => {
    vi.mocked(getExpertConfigurationService).mockImplementation(() => {
      throw new Error("unavailable");
    });
    await expect(resolveReviewExpert(42, "bug")).rejects.toThrow(
      ReviewConfigurationError,
    );
  });

  it.each([undefined, 0, -1, Number.MAX_SAFE_INTEGER + 1])(
    "refuse une installation invalide %s",
    async (id) => {
      await expect(resolveReviewExpert(id, "bug")).rejects.toThrow(
        ReviewConfigurationError,
      );
      expect(getExpertConfigurationService).not.toHaveBeenCalled();
    },
  );
});
