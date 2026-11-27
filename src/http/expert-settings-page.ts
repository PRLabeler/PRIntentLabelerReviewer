import type { WebSession } from "../auth/web-auth.js";
import type { ExpertConfigurationSummary } from "../configuration/expert-configuration.js";
import {
  buildDefaultExpertPrompt,
  type ExpertPromptSummary,
} from "../configuration/expert-prompts.js";
import {
  EXPERT_DEFINITIONS,
  type ExpertIntention,
} from "../configuration/expert-definitions.js";
import { LLM_PROVIDER_DEFINITIONS } from "../llm/provider-configuration.js";
import { escapeHtml, renderPage } from "./html.js";
import { renderLlmSettingsForm } from "./llm-settings-form.js";

export function renderExpertLinks(installationId: number): string {
  return `<details class="expert-configuration-links">
    <summary>Fournisseurs, modèles et clés API des experts</summary>
    <p>Les configurations LLM sont partagées entre les dépôts de cette installation.</p>
    <div class="actions">${Object.entries(EXPERT_DEFINITIONS)
      .map(
        ([intention, definition]) =>
          `<a class="button secondary" href="/settings/${installationId}/experts/${intention}">${escapeHtml(definition.displayName)}</a>`,
      )
      .join("")}</div>
  </details>`;
}

export function renderExpertSettingsPage(options: {
  installationId: number;
  intention: ExpertIntention;
  session: WebSession;
  configuration: ExpertConfigurationSummary | null;
  prompt?: ExpertPromptSummary;
  notice?: string;
  error?: string;
}): string {
  const { installationId, intention, configuration, session } = options;
  const definition = EXPERT_DEFINITIONS[intention];
  const expertName = escapeHtml(definition.displayName);
  const path = `/settings/${installationId}/experts/${intention}`;
  const prompt = options.prompt ?? {
    installationId,
    intention,
    systemPrompt: buildDefaultExpertPrompt(intention),
    isCustom: false,
  };
  const promptStatus = prompt.isCustom
    ? `<p class="muted">Prompt personnalisé${prompt.updatedAt ? ` — dernière modification : ${escapeHtml(prompt.updatedAt.toLocaleString("fr-CA"))}` : ""}</p>`
    : `<p class="muted">Prompt par défaut</p>`;
  const promptSection = `<section class="card" id="expert-prompt">
    <h2>Prompt de l’expert ${expertName}</h2>
    <p>Texte des instructions système envoyées au LLM lors de la revue par l’expert ${expertName}.</p>
    ${promptStatus}
    <form method="post" action="${path}/prompt/save">
      <input type="hidden" name="_csrf" value="${escapeHtml(session.csrfToken)}">
      <label for="systemPrompt">Prompt système</label>
      <textarea id="systemPrompt" name="systemPrompt" rows="16" required>${escapeHtml(prompt.systemPrompt)}</textarea>
      <small>Conservez la structure JSON attendue (<code>summary</code> et <code>findings</code>) afin que les commentaires de revue soient correctement publiés.</small>
      <div class="actions">
        <button type="submit">Enregistrer le prompt</button>
      </div>
    </form>
    ${
      prompt.isCustom
        ? `<form method="post" action="${path}/prompt/reset">
      <input type="hidden" name="_csrf" value="${escapeHtml(session.csrfToken)}">
      <div class="actions">
        <button class="secondary" type="submit">Réinitialiser le prompt par défaut</button>
      </div>
    </form>`
        : ""
    }
  </section>`;
  return renderPage(
    `Expert ${definition.displayName}`,
    `<section class="card">
    <h1>Configuration de l’expert ${expertName}</h1>
    <p>Installation GitHub <code>#${installationId}</code> — connecté en tant que <strong>${escapeHtml(session.githubLogin)}</strong></p>
    <div class="notice">La configuration enregistrée est utilisée à la prochaine analyse d’une PR pour laquelle cet expert est sélectionné. Le diff et son contexte sont envoyés au fournisseur choisi. Une analyse déjà lancée conserve sa configuration initiale.</div>
    <p>Cette configuration concerne uniquement l’expert ${expertName} de cette installation GitHub.</p>
    ${options.error ? `<div class="notice error">${escapeHtml(options.error)}</div>` : ""}
    ${options.notice ? `<div class="notice success">${escapeHtml(options.notice)}</div>` : ""}
    <p>Le test de connexion vérifie l’accès au modèle choisi. Il ne lance aucune revue et ne publie aucun commentaire GitHub.</p>
    ${renderLlmSettingsForm({
      configuration,
      csrfToken: session.csrfToken,
      saveUrl: `${path}/save`,
      testUrl: `/api/installations/${installationId}/experts/${intention}/llm/test`,
      backUrl: `/settings/${installationId}`,
      backLabel: "Retour aux paramètres",
      providers: definition.providers,
      defaultProvider: "gemini",
      showBaseUrl: false,
    })}
  </section>
  ${
    configuration
      ? `<section class="card">
    <h2>Configuration enregistrée — expert ${expertName}</h2>
    <p>${escapeHtml(LLM_PROVIDER_DEFINITIONS[configuration.provider].displayName)} — <code>${escapeHtml(configuration.model)}</code> — clé terminant par <code>${escapeHtml(configuration.keyLastFour)}</code></p>
    <p class="muted">Dernière modification : ${escapeHtml(configuration.updatedAt.toLocaleString("fr-CA"))}</p>
    <form method="post" action="${path}/delete">
      <p>Après suppression, l’expert ${expertName} utilisera le repli Gemini du serveur, s’il est configuré. Les configurations des autres experts et installations seront conservées.</p>
      <input type="hidden" name="_csrf" value="${escapeHtml(session.csrfToken)}">
      <button class="danger" type="submit">Supprimer la configuration de l’expert ${expertName}</button>
    </form>
  </section>`
      : `<section class="card"><p>Aucune configuration enregistrée pour l’expert ${expertName} de cette installation. Le repli Gemini du serveur sera utilisé s’il est configuré ; sinon, la revue spécialisée sera ignorée et signalée dans le commentaire d’analyse.</p></section>`
  }
  ${promptSection}
  <script src="/assets/settings.js" defer></script>`,
  );
}
