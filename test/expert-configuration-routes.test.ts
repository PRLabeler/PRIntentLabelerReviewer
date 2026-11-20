import express from "express";
import type { Server } from "node:http";
import { once } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerConfigurationRoutes } from "../src/http/configuration-routes.js";
import { getGitHubOAuthService } from "../src/auth/runtime.js";
import { getExpertConfigurationService } from "../src/configuration/expert-configuration-runtime.js";
import { getLlmConfigurationService } from "../src/configuration/runtime.js";
import { ExpertConfigurationService } from "../src/configuration/expert-configuration-service.js";
import { ExpertConfigurationUnavailableError } from "../src/configuration/expert-configuration.js";
import { ApiKeyCipher } from "../src/security/api-key-cipher.js";
import type {
  SaveLlmConfiguration,
  StoredLlmConfiguration,
} from "../src/configuration/llm-configuration.js";
import {
  EXPERT_DEFINITIONS,
  EXPERT_PROVIDER_NAMES,
} from "../src/configuration/expert-definitions.js";
import { registeredIntents } from "../src/review/expert-policies.js";
import { providerResponse } from "./fixtures/bug-review.js";

vi.mock("../src/auth/runtime.js", () => ({ getGitHubOAuthService: vi.fn() }));
vi.mock("../src/configuration/expert-configuration-runtime.js", () => ({
  getExpertConfigurationService: vi.fn(),
}));
vi.mock("../src/configuration/runtime.js", () => ({
  getLlmConfigurationService: vi.fn(),
}));
// Enregistrer une catégorie supplémentaire avant le chargement des pages et
// routes : aucun changement du registre de configuration ou de l'UI ne suit.
vi.mock("../src/review/expert-policies.js", async (importOriginal) => {
  const policies =
    await importOriginal<typeof import("../src/review/expert-policies.js")>();
  policies.registerExpertPolicy({
    intent: "maintenance",
    roleTitle: "maintenance Pull Requests",
    classifiedAs: "a maintenance change",
    reviewPolicy: "Verify the maintenance change.",
  });
  return policies;
});

const httpFetch = globalThis.fetch; // HTTP local uniquement ; les appels LLM sont simulés.
const session = {
  githubUserId: 7,
  githubLogin: "test-user",
  installationIds: [42],
  csrfToken: "csrf-test",
  expiresAt: new Date(Date.now() + 100000),
};
let server: Server;
let base: string;
let rows: Map<string, StoredLlmConfiguration>;
let service: ExpertConfigurationService;
const llmFetch = vi.fn();

beforeEach(async () => {
  session.installationIds = [42];
  vi.mocked(getGitHubOAuthService)
    .mockReset()
    .mockReturnValue({
      getSession: vi.fn(async () => session),
    } as unknown as NonNullable<ReturnType<typeof getGitHubOAuthService>>);
  rows = new Map();
  service = new ExpertConfigurationService(
    (intention) => ({
      findByInstallationId: async (id) =>
        rows.get(`${id}:${intention}`) ?? null,
      upsert: async (input: SaveLlmConfiguration) => {
        const row = { ...input, createdAt: new Date(), updatedAt: new Date() };
        rows.set(`${input.installationId}:${intention}`, row);
        return row;
      },
      delete: async (id) => rows.delete(`${id}:${intention}`),
    }),
    new ApiKeyCipher(Buffer.alloc(32, 4).toString("base64")),
  );
  vi.mocked(getExpertConfigurationService).mockReset().mockReturnValue(service);
  vi.mocked(getLlmConfigurationService)
    .mockReset()
    .mockReturnValue({
      getSummary: vi.fn(async () => null),
    } as unknown as NonNullable<ReturnType<typeof getLlmConfigurationService>>);
  llmFetch.mockReset().mockImplementation(async (url: string) => {
    if (url.includes("anthropic")) {
      return providerResponse("anthropic", "OK");
    }
    if (url.includes("googleapis")) {
      return providerResponse("gemini", "OK");
    }
    return providerResponse("openai", "OK");
  });
  vi.stubGlobal("fetch", llmFetch);
  const app = express();
  const router = express.Router();
  registerConfigurationRoutes(router, {
    listRepositories: vi.fn(async () => []),
    readRepositoryLabels: vi.fn(),
  });
  app.use(router);
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test port");
  base = `http://127.0.0.1:${address.port}`;
});
afterEach(async () => {
  vi.unstubAllGlobals();
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});

function request(
  path: string,
  fields?: Record<string, string>,
  cookie = "pril_session=test-session",
) {
  return httpFetch(base + path, {
    redirect: "manual",
    headers: { Cookie: cookie },
    ...(fields ? { method: "POST", body: new URLSearchParams(fields) } : {}),
  });
}
const form = {
  _csrf: "csrf-test",
  provider: "openai",
  model: "test-model",
  apiKey: "fake-private-key-1234",
};
const path = "/settings/42/experts/bug";
const testPath = "/api/installations/42/experts/bug/llm/test";

describe("routes des experts avec vrai service et clients externes simulés", () => {
  it("réserve les experts et le formulaire du classifieur aux paramètres d'une installation", async () => {
    expect(registeredIntents()).toContain("maintenance");
    const installations = await request("/settings");
    expect(installations.status).toBe(200);
    const installationsHtml = await installations.text();
    expect(installationsHtml).toContain('href="/settings/42"');
    expect(installationsHtml).not.toContain("Experts IA par intention");
    expect(installationsHtml).not.toContain("/experts/");
    expect(installationsHtml).not.toContain('id="llm-settings-form"');
    const response = await request("/settings/42");
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).toContain(`href="${path}"`);
    expect(html).toContain('action="/settings/42/save"');
    expect(html).toContain("Experts IA");
    expect(html).toContain("Classifieur d’intention");
    for (const intention of registeredIntents()) {
      const link = `href="/settings/42/experts/${intention}"`;
      expect(html).toContain(link);
    }
    expect(html).not.toContain("Seul l’expert Bug");
    expect(getExpertConfigurationService).not.toHaveBeenCalled();
  });

  it.each(
    registeredIntents().flatMap((intention) =>
      EXPERT_PROVIDER_NAMES.map((provider) => ({ intention, provider })),
    ),
  )(
    "teste, enregistre, relit, modifie et supprime $intention avec $provider",
    async ({ intention, provider }) => {
      const path = `/settings/42/experts/${intention}`;
      const testPath = `/api/installations/42/experts/${intention}/llm/test`;
      const expertName = EXPERT_DEFINITIONS[intention].displayName;
      const test = await request(testPath, { ...form, provider });
      expect(test.status).toBe(200);
      const testBody = (await test.json()) as { message: string };
      expect(testBody.message).toContain(`expert ${expertName}`);
      expect(rows.size).toBe(0);
      const saved = await request(`${path}/save`, { ...form, provider });
      expect(saved.status).toBe(302);
      expect(saved.headers.get("location")).toBe(`${path}?saved=1`);
      expect(JSON.stringify(rows.get(`42:${intention}`))).not.toContain(
        form.apiKey,
      );
      const page = await request(`${path}?saved=1`);
      const html = await page.text();
      expect(page.headers.get("cache-control")).toBe("no-store");
      expect(page.headers.get("content-security-policy")).toContain(
        "script-src 'self'",
      );
      expect(html).toContain("1234");
      expect(html).not.toContain(form.apiKey);
      expect(html).toContain(
        `Configuration de l’expert ${expertName} testée et enregistrée`,
      );
      expect(html).toContain("pour laquelle cet expert est sélectionné");
      expect(html).toContain("utilisée à la prochaine analyse");
      expect(html).not.toContain("activation à venir");
      const updated = await request(`${path}/save`, {
        ...form,
        provider,
        model: "new-model",
        apiKey: "",
      });
      expect(updated.status).toBe(302);
      expect(await service.resolve(42, intention)).toMatchObject({
        provider,
        model: "new-model",
        apiKey: form.apiKey,
      });
      const deleted = await request(`${path}/delete`, { _csrf: form._csrf });
      expect(deleted.status).toBe(302);
      expect(deleted.headers.get("location")).toBe(`${path}?deleted=1`);
      expect(await service.resolve(42, intention)).toBeNull();
      const deletedPage = await request(`${path}?deleted=1`);
      expect(await deletedPage.text()).toContain(
        `configuration de l’expert ${expertName} a été supprimée`,
      );
    },
  );

  it("isole les clés et les modifications entre catégories et installations via les routes", async () => {
    session.installationIds = [42, 43];
    const scopes = [
      {
        installationId: 42,
        intention: "bug",
        provider: "openai",
        model: "bug-installation-42",
        apiKey: "fake-key-bug-1111",
      },
      {
        installationId: 42,
        intention: "feature",
        provider: "anthropic",
        model: "feature-installation-42",
        apiKey: "fake-key-feature-2222",
      },
      {
        installationId: 43,
        intention: "bug",
        provider: "gemini",
        model: "bug-installation-43",
        apiKey: "fake-key-bug-3333",
      },
      {
        installationId: 43,
        intention: "feature",
        provider: "openai",
        model: "feature-installation-43",
        apiKey: "fake-key-feature-4444",
      },
    ];
    for (const scope of scopes) {
      const path = `/settings/${scope.installationId}/experts/${scope.intention}`;
      const response = await request(`${path}/save`, {
        ...form,
        provider: scope.provider,
        model: scope.model,
        apiKey: scope.apiKey,
      });
      expect(response.status).toBe(302);
    }
    expect(rows.size).toBe(4);

    const test = await request(
      "/api/installations/42/experts/feature/llm/test",
      {
        ...form,
        provider: "anthropic",
        model: "tested-without-saving",
        apiKey: "",
      },
    );
    expect(test.status).toBe(200);
    expect((await service.resolve(42, "feature"))?.model).toBe(
      "feature-installation-42",
    );

    const updated = await request("/settings/42/experts/feature/save", {
      ...form,
      provider: "anthropic",
      model: "updated-feature-model",
      apiKey: "",
      // Ces champs supplémentaires ne doivent jamais remplacer le scope URL.
      installationId: "43",
      intention: "bug",
    });
    expect(updated.status).toBe(302);
    for (const scope of scopes) {
      const isUpdated =
        scope.installationId === 42 && scope.intention === "feature";
      const expectedModel = isUpdated ? "updated-feature-model" : scope.model;
      expect(
        await service.resolve(scope.installationId, scope.intention),
      ).toMatchObject({
        provider: scope.provider,
        model: expectedModel,
        apiKey: scope.apiKey,
      });
      const page = await request(
        `/settings/${scope.installationId}/experts/${scope.intention}`,
      );
      const html = await page.text();
      expect(html).toContain(`value="${expectedModel}"`);
      expect(html).toContain(`value="${scope.provider}" selected`);
      for (const otherScope of scopes) {
        expect(html).not.toContain(otherScope.apiKey);
        if (otherScope !== scope) expect(html).not.toContain(otherScope.model);
      }
    }
    const deleted = await request("/settings/42/experts/feature/delete", {
      _csrf: form._csrf,
    });
    expect(deleted.status).toBe(302);
    expect(await service.resolve(42, "feature")).toBeNull();
    for (const scope of [scopes[0], scopes[2], scopes[3]]) {
      expect(
        (await service.resolve(scope.installationId, scope.intention))?.model,
      ).toBe(scope.model);
    }
  });

  it.each(["bug", "security"])(
    "rejette une nouvelle clé %s sans remplacer l'ancienne ni la réafficher",
    async (intention) => {
      const path = `/settings/42/experts/${intention}`;
      await request(`${path}/save`, form);
      llmFetch.mockImplementation(async () =>
        Response.json(
          { error: { message: "fake-rejected-secret" } },
          { status: 401 },
        ),
      );
      const response = await request(`${path}/save`, {
        ...form,
        apiKey: "fake-rejected-secret",
      });
      expect(response.status).toBe(400);
      const html = await response.text();
      expect(html).toContain("401");
      expect(html).toContain(
        `Expert ${EXPERT_DEFINITIONS[intention].displayName}`,
      );
      expect(html).not.toContain("fake-rejected-secret");
      expect(html).not.toContain(form.apiKey);
      expect((await service.resolve(42, intention))?.apiKey).toBe(form.apiKey);
    },
  );

  it.each(
    ["bug", "feature", "security"].flatMap((intention) => [
      `/settings/42/experts/${intention}/save`,
      `/settings/42/experts/${intention}/delete`,
      `/api/installations/42/experts/${intention}/llm/test`,
    ]),
  )("protège %s contre les mutations sans CSRF", async (url) => {
    const response = await request(url, { ...form, _csrf: "invalid" });
    expect(response.status).toBe(403);
    expect(getExpertConfigurationService).not.toHaveBeenCalled();
    expect(llmFetch).not.toHaveBeenCalled();
  });

  it.each(["bug", "feature", "security"])(
    "protège l'accès OAuth à %s",
    async (intention) => {
      const path = `/settings/42/experts/${intention}`;
      const testPath = `/api/installations/42/experts/${intention}/llm/test`;
      const response = await request(path, undefined, "");
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe(
        "/auth/github?installation_id=42",
      );
      expect((await request(testPath, form, "")).status).toBe(403);
      expect((await request(`${path}/save`, form, "")).status).toBe(403);
      expect(
        (await request(`${path}/delete`, { _csrf: form._csrf }, "")).status,
      ).toBe(403);
      expect(getExpertConfigurationService).not.toHaveBeenCalled();
    },
  );

  it.each([
    "/settings/43/experts/bug",
    "/settings/43/experts/feature",
    "/settings/invalid/experts/security",
  ])("refuse l'accès à %s", async (url) => {
    expect((await request(url)).status).toBe(403);
    expect((await request(`${url}/save`, form)).status).toBe(403);
    expect((await request(`${url}/delete`, { _csrf: form._csrf })).status).toBe(
      403,
    );
    expect(getExpertConfigurationService).not.toHaveBeenCalled();
  });

  it("refuse un test de connexion pour une installation non autorisée", async () => {
    const response = await request(
      "/api/installations/43/experts/security/llm/test",
      form,
    );
    expect(response.status).toBe(403);
    expect(getExpertConfigurationService).not.toHaveBeenCalled();
    expect(llmFetch).not.toHaveBeenCalled();
  });

  it("refuse les intentions inactives et les fournisseurs hors V1", async () => {
    expect((await request("/settings/42/experts/unknown-expert")).status).toBe(
      404,
    );
    expect(
      (await request("/settings/42/experts/unknown-expert/save", form)).status,
    ).toBe(404);
    expect(
      (await request(testPath, { ...form, provider: "groq" })).status,
    ).toBe(400);
    expect(
      (await request(`${path}/save`, { ...form, provider: "custom" })).status,
    ).toBe(400);
    expect(llmFetch).not.toHaveBeenCalled();
  });

  it("valide les longueurs et refuse un endpoint personnalisé", async () => {
    expect(
      (await request(testPath, { ...form, model: "m".repeat(161) })).status,
    ).toBe(400);
    expect(
      (await request(testPath, { ...form, baseUrl: "https://other.example" }))
        .status,
    ).toBe(400);
    expect(llmFetch).not.toHaveBeenCalled();
  });

  it("exige une nouvelle clé pour changer de fournisseur", async () => {
    await request(`${path}/save`, form);
    const response = await request(`${path}/save`, {
      ...form,
      provider: "anthropic",
      apiKey: "",
    });
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("nouvelle clé API");
    expect(rows.get("42:bug")?.provider).toBe("openai");
  });

  it.each(["bug", "feature"])(
    "signale une indisponibilité du service pour %s sans détails internes",
    async (intention) => {
      const path = `/settings/42/experts/${intention}`;
      const testPath = `/api/installations/42/experts/${intention}/llm/test`;
      vi.mocked(getExpertConfigurationService).mockImplementation(() => {
        throw new ExpertConfigurationUnavailableError();
      });
      const page = await request(path);
      expect(page.status).toBe(503);
      expect(await page.text()).toContain(
        `expert ${EXPERT_DEFINITIONS[intention].displayName}`,
      );
      expect((await request(testPath, form)).status).toBe(503);
      expect((await request(`${path}/save`, form)).status).toBe(503);
      expect(
        (await request(`${path}/delete`, { _csrf: form._csrf })).status,
      ).toBe(503);
    },
  );

  it.each(["bug", "security"])(
    "ne reflète pas un secret dans une exception inattendue pour %s",
    async (intention) => {
      const testPath = `/api/installations/42/experts/${intention}/llm/test`;
      vi.spyOn(service, "test").mockRejectedValue(new Error(form.apiKey));
      const response = await request(testPath, form);
      expect(response.status).toBe(400);
      const body = (await response.json()) as { message: string };
      expect(body.message).toContain(
        `Expert ${EXPERT_DEFINITIONS[intention].displayName}`,
      );
      expect(body.message).not.toContain(form.apiKey);
    },
  );
});
