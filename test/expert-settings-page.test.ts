import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { renderExpertSettingsPage } from "../src/http/expert-settings-page.js";
import {
  renderInstallationsPage,
  renderSettingsPage,
} from "../src/http/settings-page.js";
import { renderSettingsClientScript } from "../src/http/llm-settings-form.js";
import { LLM_PROVIDER_DEFINITIONS } from "../src/llm/provider-configuration.js";
import type { ExpertConfigurationSummary } from "../src/configuration/expert-configuration.js";
import { registeredIntents } from "../src/review/expert-policies.js";
import { EXPERT_DEFINITIONS } from "../src/configuration/expert-definitions.js";

const session = {
  githubUserId: 7,
  githubLogin: "<user>",
  installationIds: [42],
  csrfToken: "csrf-token",
  expiresAt: new Date(),
};
const configuration: ExpertConfigurationSummary = {
  installationId: 42,
  intention: "bug",
  provider: "anthropic",
  model: '<model "test">',
  keyLastFour: "1234",
  updatedAt: new Date(),
  updatedByGithubUserId: 7,
};

describe("pages de configuration", () => {
  it("rend l'accès à tous les experts visible sans changer les routes du classifieur", () => {
    const html = renderSettingsPage({
      installationId: 42,
      session,
      configuration: null,
    });
    expect(html).toContain('href="/settings/42/experts/bug"');
    expect(html).toContain("Experts IA");
    expect(html).toContain("Classifieur d’intention");
    expect(html).toContain('action="/settings/42/save"');
    expect(html).toContain('data-test-url="/api/installations/42/llm/test"');
    expect(html).toContain('value="groq"');
    expect(html).toContain('name="baseUrl"');
    for (const intention of registeredIntents()) {
      expect(html).toContain(`href="/settings/42/experts/${intention}"`);
    }
    expect(html).not.toContain("Seul l’expert Bug");
  });

  it("affiche uniquement les installations autorisées et leurs liens de paramètres dans /settings", () => {
    const html = renderInstallationsPage({
      ...session,
      installationIds: [42, 43],
    });
    for (const installationId of [42, 43]) {
      expect(html).toContain(`href="/settings/${installationId}"`);
    }
    expect(html).not.toContain("Experts IA par intention");
    expect(html).not.toContain("/experts/");
    expect(html).not.toContain('id="llm-settings-form"');
    expect(html).not.toContain("/settings/44");
    const emptyHtml = renderInstallationsPage({
      ...session,
      installationIds: [],
    });
    expect(emptyHtml).toContain("Aucune installation accessible");
    expect(emptyHtml).not.toContain("/experts/");
  });

  it.each(registeredIntents())(
    "affiche le formulaire et les messages de l'expert %s",
    (intention) => {
      const expertName = EXPERT_DEFINITIONS[intention].displayName;
      const html = renderExpertSettingsPage({
        installationId: 42,
        intention,
        session,
        configuration: { ...configuration, intention },
      });
      for (const provider of ["anthropic", "openai", "gemini"])
        expect(html).toContain(`value="${provider}"`);
      for (const provider of ["groq", "custom", "xai", "perplexity"])
        expect(html).not.toContain(`value="${provider}"`);
      expect(html).not.toContain('name="baseUrl"');
      expect(html).toContain(`action="/settings/42/experts/${intention}/save"`);
      expect(html).toContain(
        `action="/settings/42/experts/${intention}/delete"`,
      );
      expect(html).toContain(
        `data-test-url="/api/installations/42/experts/${intention}/llm/test"`,
      );
      expect(html).toContain("utilisée à la prochaine analyse");
      expect(html).toContain("Après suppression");
      expect(html).toContain(
        `<title>Expert ${expertName} — PRIntentLabeler</title>`,
      );
      expect(html).toContain(`Configuration de l’expert ${expertName}`);
      expect(html).toContain("pour laquelle cet expert est sélectionné");
      expect(html).toContain(
        `uniquement l’expert ${expertName} de cette installation`,
      );
      expect(html).toContain(
        "Les configurations des autres experts et installations seront conservées",
      );
      if (intention !== "bug") expect(html).not.toContain("Bug");
      expect(html).not.toContain("activation à venir");
      expect(html).toContain("&lt;user&gt;");
      expect(html).toContain("&lt;model &quot;test&quot;&gt;");
      expect(html).toContain("terminant par <code>1234</code>");
      expect(html).toMatch(/name="apiKey"[^>]*type="password"[^>]*>/);
      expect(html.match(/<input[^>]*name="apiKey"[^>]*>/)?.[0]).not.toContain(
        "value=",
      );
      expect(html).toContain('name="_csrf" value="csrf-token"');
    },
  );

  it.each(registeredIntents())(
    "permet de créer une configuration %s et échappe les erreurs",
    (intention) => {
      const html = renderExpertSettingsPage({
        installationId: 42,
        intention,
        session,
        configuration: null,
        error: "<script>alert(1)</script>",
      });
      expect(html).not.toContain(`/experts/${intention}/delete`);
      expect(html).toContain("Aucune configuration enregistrée");
      expect(html).toContain(
        `pour l’expert ${EXPERT_DEFINITIONS[intention].displayName} de cette installation`,
      );
      expect(html.match(/<input[^>]*name="apiKey"[^>]*>/)?.[0]).toContain(
        "required",
      );
      expect(html).toContain("&lt;script&gt;");
    },
  );
});

function clientFixture(intention = "bug") {
  const listeners: Record<string, () => void | Promise<void>> = {};
  const provider = {
    value: "gemini",
    addEventListener: (_: string, fn: () => void) => {
      listeners.change = fn;
    },
  };
  const model = { value: LLM_PROVIDER_DEFINITIONS.gemini.defaultModel };
  const form = {
    dataset: {
      storedProvider: "gemini",
      testUrl: `/api/installations/42/experts/${intention}/llm/test`,
    },
    reportValidity: vi.fn(() => true),
  };
  const key = { required: false };
  const suggestions = { replaceChildren: vi.fn() };
  const result = { className: "", textContent: "" };
  const button = {
    disabled: false,
    addEventListener: (_: string, fn: () => Promise<void>) => {
      listeners.test = fn;
    },
  };
  const elements: Record<string, unknown> = {
    "llm-settings-form": form,
    provider,
    model,
    apiKey: key,
    "known-models": suggestions,
    "connection-result": result,
    "test-connection": button,
  };
  const fetch = vi.fn(async () => ({
    ok: true,
    json: async () => ({ message: "Connexion réussie" }),
  }));
  class FormData {
    *[Symbol.iterator]() {
      yield ["_csrf", "csrf-token"];
      yield ["provider", provider.value];
    }
  }
  runInNewContext(renderSettingsClientScript(), {
    document: {
      getElementById: (id: string) => elements[id] ?? null,
      createElement: () => ({ value: "" }),
    },
    fetch,
    FormData,
    URLSearchParams,
  });
  return {
    listeners,
    provider,
    model,
    form,
    key,
    suggestions,
    result,
    button,
    fetch,
  };
}

describe("script partagé de configuration", () => {
  it("actualise les suggestions et exige une nouvelle clé quand le fournisseur change", async () => {
    const ui = clientFixture();
    ui.provider.value = "anthropic";
    await ui.listeners.change();
    expect(ui.model.value).toBe(
      LLM_PROVIDER_DEFINITIONS.anthropic.defaultModel,
    );
    expect(ui.key.required).toBe(true);
    expect(
      ui.suggestions.replaceChildren.mock.calls
        .at(-1)
        ?.map((option) => option.value),
    ).toEqual(LLM_PROVIDER_DEFINITIONS.anthropic.suggestedModels);
    ui.model.value = "custom-model-id";
    ui.provider.value = "gemini";
    await ui.listeners.change();
    expect(ui.model.value).toBe("custom-model-id");
    expect(ui.key.required).toBe(false);
  });

  it.each(["bug", "feature", "security"])(
    "envoie le test de %s à l'URL dédiée sans enregistrer",
    async (intention) => {
      const ui = clientFixture(intention);
      await ui.listeners.test();
      expect(ui.fetch).toHaveBeenCalledWith(
        ui.form.dataset.testUrl,
        expect.objectContaining({ method: "POST" }),
      );
      const init = (
        ui.fetch.mock.calls[0] as unknown as [string, RequestInit]
      )[1];
      expect(String(init.body)).toContain("_csrf=csrf-token");
      expect(ui.result.textContent).toBe("Connexion réussie");
      expect(ui.button.disabled).toBe(false);
    },
  );

  it("n'envoie pas un formulaire invalide et affiche les erreurs réseau sans HTML", async () => {
    const ui = clientFixture();
    ui.form.reportValidity.mockReturnValue(false);
    await ui.listeners.test();
    expect(ui.fetch).not.toHaveBeenCalled();
    ui.form.reportValidity.mockReturnValue(true);
    ui.fetch.mockRejectedValue(new Error("network"));
    await ui.listeners.test();
    expect(ui.result.textContent).toContain("inaccessible");
    expect(ui.button.disabled).toBe(false);
  });
});
