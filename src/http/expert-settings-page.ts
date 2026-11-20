import type { WebSession } from "../auth/web-auth.js";
import type { ExpertConfigurationSummary } from "../configuration/expert-configuration.js";
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
  notice?: string;
  error?: string;
}): string {
  const { installationId, intention, configuration, session } = options;
  const definition = EXPERT_DEFINITIONS[intention];
  const expertName = escapeHtml(definition.displayName);
  const path = `/settings/${installationId}/experts/${intention}`;
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
  <script src="/assets/settings.js" defer></script>`,
  );
}
