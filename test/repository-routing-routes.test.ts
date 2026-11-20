import express from "express";
import { once } from "node:events";
import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getGitHubOAuthService } from "../src/auth/runtime.js";
import { getLlmConfigurationService } from "../src/configuration/runtime.js";
import { getRepositoryRoutingService } from "../src/configuration/repository-routing-runtime.js";
import { RepositoryRoutingService } from "../src/configuration/repository-routing-service.js";
import type {
  SaveRepositoryRoutingPolicy,
  StoredRepositoryRoutingPolicy,
} from "../src/configuration/repository-routing.js";
import type { ExpertRoutingScope } from "../src/domain/expert-routing.js";
import {
  InstallationRepositoryReader,
  type InstallationRepositoryClient,
} from "../src/github/installation-repository-reader.js";
import { registerConfigurationRoutes } from "../src/http/configuration-routes.js";

vi.mock("../src/auth/runtime.js", () => ({ getGitHubOAuthService: vi.fn() }));
vi.mock("../src/configuration/runtime.js", () => ({
  getLlmConfigurationService: vi.fn(),
}));
vi.mock("../src/configuration/repository-routing-runtime.js", () => ({
  getRepositoryRoutingService: vi.fn(),
}));

const httpFetch = globalThis.fetch;
const session = {
  githubUserId: 7,
  githubLogin: "user",
  installationIds: [42],
  csrfToken: "csrf-test",
  expiresAt: new Date(Date.now() + 100000),
};
const path = "/settings/42/repositories/123/routing";
const initialLabels = [
  { id: 10, name: "bug", description: "Corrige un défaut" },
  { id: 11, name: "enhancement", description: null },
  { id: 12, name: "refactor", description: null },
  { id: 13, name: "security", description: null },
  { id: 14, name: "question", description: null },
  { id: 15, name: "custom-label", description: null },
];
let server: Server;
let base: string;
let rows: Map<string, StoredRepositoryRoutingPolicy>;
let labels: typeof initialLabels;
const readRepositories = vi.fn();
const readLabels = vi.fn();
const findPolicy = vi.fn();
const savePolicy = vi.fn();

beforeEach(async () => {
  session.installationIds = [42];
  rows = new Map();
  labels = structuredClone(initialLabels);
  vi.mocked(getGitHubOAuthService)
    .mockReset()
    .mockReturnValue({
      getSession: vi.fn(async () => session),
    } as unknown as NonNullable<ReturnType<typeof getGitHubOAuthService>>);
  vi.mocked(getLlmConfigurationService)
    .mockReset()
    .mockReturnValue({
      getSummary: vi.fn(async () => null),
    } as unknown as NonNullable<ReturnType<typeof getLlmConfigurationService>>);
  readRepositories
    .mockReset()
    .mockImplementation(async (installationId: number) => ({
      data: {
        repositories:
          installationId === 42
            ? [
                { id: 123, name: "repo", owner: { login: "org" } },
                { id: 124, name: "other", owner: { login: "org" } },
              ]
            : [{ id: 125, name: "private", owner: { login: "another-org" } }],
      },
    }));
  readLabels.mockReset().mockImplementation(async () => ({ data: labels }));
  const reader = new InstallationRepositoryReader(
    async (installationId) =>
      ({
        apps: {
          listReposAccessibleToInstallation: () =>
            readRepositories(installationId),
        },
        issues: { listLabelsForRepo: readLabels },
      }) as unknown as InstallationRepositoryClient,
  );
  findPolicy
    .mockReset()
    .mockImplementation(async (scope: ExpertRoutingScope) =>
      structuredClone(
        rows.get(`${scope.installationId}:${scope.repositoryId}`) ?? null,
      ),
    );
  let revision = 0;
  savePolicy
    .mockReset()
    .mockImplementation(async (input: SaveRepositoryRoutingPolicy) => {
      const key = `${input.installationId}:${input.repositoryId}`;
      const previous = rows.get(key);
      const stored: StoredRepositoryRoutingPolicy = {
        installationId: input.installationId,
        repositoryId: input.repositoryId,
        defaultBehavior: input.defaultBehavior,
        mappings: structuredClone(input.mappings),
        createdAt: previous?.createdAt ?? new Date("2026-01-01T00:00:00Z"),
        updatedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, ++revision)),
        createdByGithubUserId:
          previous?.createdByGithubUserId ?? input.githubUserId ?? null,
        updatedByGithubUserId: input.githubUserId ?? null,
      };
      rows.set(key, stored);
      return stored;
    });
  const service = new RepositoryRoutingService({
    findByRepository: findPolicy,
    upsert: savePolicy,
    deleteForInstallation: vi.fn(),
  });
  vi.mocked(getRepositoryRoutingService).mockReset().mockReturnValue(service);
  const app = express();
  const router = express.Router();
  registerConfigurationRoutes(router, reader);
  app.use(router);
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Port local absent");
  base = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});

function request(
  url: string,
  fields?: Record<string, string> | URLSearchParams,
  cookie = "pril_session=test-session",
) {
  return httpFetch(base + url, {
    redirect: "manual",
    headers: { Cookie: cookie },
    ...(fields ? { method: "POST", body: new URLSearchParams(fields) } : {}),
  });
}

function form(
  overrides: Record<string, string> = {},
  key = "42:123",
): Record<string, string> {
  return {
    _csrf: session.csrfToken,
    policyVersion: rows.get(key)?.updatedAt.toISOString() ?? "absent",
    labelIds: "10,11,12,13,14,15",
    label_10: "expert:bug",
    label_11: "expert:feature",
    label_12: "expert:refactor",
    label_13: "expert:security",
    label_14: "expert:general",
    label_15: "expert:general",
    ...overrides,
  };
}

function selected(html: string, id: number): string | undefined {
  const options = html.match(
    new RegExp(`<select[^>]*name="label_${id}"[^>]*>([\\s\\S]*?)</select>`),
  )?.[1];
  return options?.match(/<option value="([^"]*)" selected>/)?.[1];
}

describe("interface de correspondances (HTTP local, services et lecteur réels)", () => {
  it("affiche deux sections avec le tableau et le sélecteur de dépôt intégrés, sans écriture", async () => {
    const settings = await request("/settings/42");
    const settingsHtml = await settings.text();
    expect(settings.status).toBe(200);
    expect(settingsHtml.match(/<section class="card"/g) ?? []).toHaveLength(2);
    expect(settingsHtml).toContain('id="classifier"');
    expect(settingsHtml).toContain('id="experts"');
    expect(settingsHtml).toContain('<th scope="col">Label GitHub</th>');
    expect(settingsHtml).toContain('<th scope="col">Expert IA</th>');
    expect(settingsHtml).toContain('name="repositoryId"');
    expect(settingsHtml).toContain('href="/settings/42/experts/general"');
    expect(settingsHtml).not.toContain('href="/settings/42/repositories"');
    expect(settingsHtml).toContain('action="/settings/42/save"');
    const listing = await request("/settings/42/repositories");
    expect(listing.status).toBe(302);
    expect(listing.headers.get("location")).toBe("/settings/42#experts");
    const response = await request("/settings/42?repositoryId=124");
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-security-policy")).toContain(
      "script-src 'self'",
    );
    expect(html).toContain("Corrige un défaut");
    expect(html).toContain('value="124" selected');
    expect(html).toContain(
      'action="/settings/42/repositories/124/routing/save"',
    );
    for (const label of initialLabels) {
      expect(selected(html, label.id)).toBe("expert:general");
    }
    expect(html).not.toContain("Défaut du dépôt");
    expect(html).not.toContain('name="defaultBehavior"');
    expect(html).not.toContain('value="inherit"');
    expect(savePolicy).not.toHaveBeenCalled();
    expect(rows.size).toBe(0);
  });

  it("enregistre Aucun, Général et les spécialistes sans réglage global et conserve ces choix à la relecture", async () => {
    const response = await request(
      `${path}/save`,
      form({
        label_10: "none",
        label_11: "expert:feature",
        label_15: "expert:general",
        installationId: "999",
        repositoryId: "999",
      }),
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      "/settings/42?repositoryId=123&routingSaved=1#experts",
    );
    const stored = rows.get("42:123")!;
    expect(stored.defaultBehavior).toBe("general");
    expect(stored.updatedByGithubUserId).toBe(7);
    expect(
      stored.mappings.find((mapping) => mapping.labelId === 10)?.target,
    ).toEqual({ kind: "none" });
    expect(
      stored.mappings.find((mapping) => mapping.labelId === 11)?.target,
    ).toEqual({ kind: "expert", expertId: "feature" });
    expect(
      stored.mappings.find((mapping) => mapping.labelId === 15)?.target,
    ).toEqual({ kind: "expert", expertId: "general" });
    const html = await (await request(path)).text();
    expect(selected(html, 10)).toBe("none");
    expect(selected(html, 11)).toBe("expert:feature");
    expect(html).not.toContain("Proposition initiale");
    expect(rows.size).toBe(1);
  });

  it("isole les politiques entre dépôts et installations", async () => {
    session.installationIds = [42, 43];
    expect((await request(`${path}/save`, form())).status).toBe(302);
    expect(
      (
        await request(
          "/settings/42/repositories/124/routing/save",
          form({ label_10: "none" }, "42:124"),
        )
      ).status,
    ).toBe(302);
    expect(
      (
        await request(
          "/settings/43/repositories/125/routing/save",
          form({}, "43:125"),
        )
      ).status,
    ).toBe(302);
    expect(rows.size).toBe(3);
    expect(rows.get("42:123")?.mappings[0].target).toEqual({
      kind: "expert",
      expertId: "bug",
    });
    expect(rows.get("42:124")?.mappings[0].target).toEqual({ kind: "none" });
    expect(rows.get("43:125")?.defaultBehavior).toBe("general");
  });

  it("conserve les identifiants lors d'un renommage et affiche les règles supprimées sans les transférer", async () => {
    await request(`${path}/save`, form({ label_11: "none" }));
    labels = [
      { id: 10, name: "correctness", description: null },
      { id: 50, name: "enhancement", description: null },
      { id: 16, name: "new-label", description: null },
    ];
    const writes = savePolicy.mock.calls.length;
    const html = await (await request(path)).text();
    expect(selected(html, 10)).toBe("expert:bug");
    expect(selected(html, 50)).toBe("expert:general");
    expect(selected(html, 16)).toBe("expert:general");
    expect(selected(html, 11)).toBe("none");
    expect(html).toContain("label supprimé");
    expect(savePolicy).toHaveBeenCalledTimes(writes);
    const fields = form({
      labelIds: "10,50,16,11,12,13",
      label_50: "expert:general",
      label_16: "expert:general",
      label_11: "none",
      label_12: "none",
      label_13: "none",
    });
    delete fields.label_14;
    delete fields.label_15;
    expect((await request(`${path}/save`, fields)).status).toBe(302);
    expect(
      rows
        .get("42:123")
        ?.mappings.map((mapping) => [mapping.labelId, mapping.labelName]),
    ).toEqual([
      [10, "correctness"],
      [50, "enhancement"],
      [16, "new-label"],
      [11, "enhancement"],
      [12, "refactor"],
      [13, "security"],
      [14, "question"],
      [15, "custom-label"],
    ]);
    expect(
      rows.get("42:123")?.mappings.find((mapping) => mapping.labelId === 50)
        ?.target,
    ).toEqual({ kind: "expert", expertId: "general" });
  });

  it("refuse un label supprimé après ouverture du formulaire sans sauvegarder les autres choix", async () => {
    const fields = form();
    labels = labels.filter((label) => label.id !== 10);
    const response = await request(`${path}/save`, fields);
    expect(response.status).toBe(409);
    expect(await response.text()).toContain("supprimé ou recréé");
    expect(savePolicy).not.toHaveBeenCalled();
    expect(rows.size).toBe(0);
  });

  it("vérifie session, installation, dépôt et CSRF avant toute sauvegarde", async () => {
    expect((await request(path, undefined, "")).status).toBe(302);
    expect(
      (await request("/settings/43/repositories/125/routing")).status,
    ).toBe(403);
    expect(
      (await request(`${path}/save`, form({ _csrf: "incorrect" }))).status,
    ).toBe(403);
    expect((await request(`${path}/save`, form(), "")).status).toBe(403);
    expect(readRepositories).not.toHaveBeenCalled();
    expect((await request("/settings/42?repositoryId=999")).status).toBe(404);
    expect(
      (await request("/settings/42/repositories/999/routing")).status,
    ).toBe(404);
    expect(
      (await request("/settings/42/repositories/999/routing/save", form()))
        .status,
    ).toBe(404);
    expect(readLabels).not.toHaveBeenCalled();
    expect(findPolicy).not.toHaveBeenCalled();
    expect(savePolicy).not.toHaveBeenCalled();
  });

  it("rejette un formulaire incomplet ou une cible inconnue sans sauvegarde partielle", async () => {
    const missing = form();
    delete missing.label_10;
    expect((await request(`${path}/save`, missing)).status).toBe(400);
    expect(
      (await request(`${path}/save`, form({ label_10: "expert:unknown" })))
        .status,
    ).toBe(400);
    expect(
      (await request(`${path}/save`, form({ label_10: "inherit" }))).status,
    ).toBe(400);
    const repeated = new URLSearchParams(form());
    repeated.append("label_10", "none");
    expect((await request(`${path}/save`, repeated)).status).toBe(400);
    expect(savePolicy).not.toHaveBeenCalled();
  });

  it("présente les erreurs GitHub et PostgreSQL sans exposer leurs détails", async () => {
    readRepositories.mockRejectedValueOnce(
      Object.assign(new Error("fake-secret-github"), { status: 429 }),
    );
    const github = await request(path);
    expect(github.status).toBe(502);
    const githubHtml = await github.text();
    expect(githubHtml).toContain("limite de requêtes GitHub");
    expect(githubHtml).not.toContain("fake-secret");
    expect(githubHtml).not.toContain("Aucun dépôt accessible");
    findPolicy.mockRejectedValueOnce(new Error("fake-secret-sql"));
    const storage = await request(path);
    expect(storage.status).toBe(503);
    expect(await storage.text()).not.toContain("fake-secret");
    expect(savePolicy).not.toHaveBeenCalled();
  });

  it("identifie la migration 003 manquante sans masquer le classifieur ni inventer une politique vide", async () => {
    findPolicy.mockRejectedValue(
      Object.assign(new Error("fake-sensitive-sql-detail"), { code: "42P01" }),
    );
    const response = await request(
      "/settings/42?repositoryId=123&routingSaved=1",
    );
    const html = await response.text();
    expect(response.status).toBe(503);
    expect(html).toContain("migration 003");
    expect(html).toContain("npm run db:migrate");
    expect(html).toContain('action="/settings/42/save"');
    expect(html).toContain("Corrige un défaut");
    expect(html).toContain("Indisponible");
    expect(html).not.toContain('name="label_10"');
    expect(html).not.toContain("fake-sensitive");
    expect(html).not.toContain("Les correspondances ont été enregistrées");
    expect((await request(`${path}/save`, form())).status).toBe(503);
    expect(savePolicy).not.toHaveBeenCalled();
  });

  it("conserve les choix du formulaire après échec de sauvegarde et laisse la politique précédente intacte", async () => {
    await request(`${path}/save`, form());
    const before = structuredClone(rows.get("42:123"));
    savePolicy.mockRejectedValueOnce(new Error("fake-secret-sql"));
    const response = await request(
      `${path}/save`,
      form({
        label_10: "none",
        label_15: "expert:general",
      }),
    );
    const html = await response.text();
    expect(response.status).toBe(503);
    expect(html).not.toContain("fake-secret");
    expect(selected(html, 10)).toBe("none");
    expect(selected(html, 15)).toBe("expert:general");
    expect(rows.get("42:123")).toEqual(before);
  });

  it("détecte une politique modifiée depuis l'ouverture du formulaire", async () => {
    const stale = form();
    await request(`${path}/save`, form({ label_10: "none" }));
    const response = await request(`${path}/save`, stale);
    expect(response.status).toBe(409);
    expect(await response.text()).toContain("configuration a changé");
    expect(savePolicy).toHaveBeenCalledTimes(1);
    expect(rows.get("42:123")?.mappings[0].target).toEqual({ kind: "none" });
  });

  it("accepte un catalogue volumineux sans changer les limites des formulaires LLM", async () => {
    labels = Array.from({ length: 600 }, (_, index) => ({
      id: index + 1,
      name: `label-${index}`,
      description: null,
    }));
    const fields: Record<string, string> = {
      _csrf: session.csrfToken,
      policyVersion: "absent",
      labelIds: labels.map((label) => label.id).join(","),
    };
    for (const label of labels)
      fields[`label_${label.id}`] = "expert:documentation";
    expect(new URLSearchParams(fields).toString().length).toBeGreaterThan(
      16384,
    );
    expect((await request(`${path}/save`, fields)).status).toBe(302);
    expect(rows.get("42:123")?.mappings).toHaveLength(600);
  });

  it("refuse un formulaire trop volumineux avant tout accès GitHub ou PostgreSQL", async () => {
    const response = await request(
      `${path}/save`,
      form({ extra: "x".repeat(300000) }),
    );
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("trop volumineux");
    expect(readRepositories).not.toHaveBeenCalled();
    expect(savePolicy).not.toHaveBeenCalled();
  });
});
