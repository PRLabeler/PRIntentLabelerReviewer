import type { WebSession } from "../auth/web-auth.js";
import { EXPERT_DEFINITIONS } from "../configuration/expert-definitions.js";
import type { StoredRepositoryRoutingPolicy } from "../configuration/repository-routing.js";
import type { RepositoryRoutingPolicy } from "../domain/expert-routing.js";
import type {
  GitHubRepository,
  GitHubRepositoryLabelCatalog,
} from "../domain/github-repository.js";
import { renderExpertLinks } from "./expert-settings-page.js";
import { escapeHtml } from "./html.js";
import {
  buildRoutingLabelRows,
  routingPolicyVersion,
} from "./repository-routing-form.js";

export type ExpertsSettingsState = {
  repositories: readonly GitHubRepository[];
  repositoryId?: number;
  catalog?: GitHubRepositoryLabelCatalog;
  // undefined = lecture impossible ; null = aucune politique enregistrée.
  policy?: StoredRepositoryRoutingPolicy | null;
  draft?: RepositoryRoutingPolicy;
  error?: string;
  status?: number;
  saved?: boolean;
};

function selectionName(value: string): string {
  if (value === "none") return "Aucun expert";
  if (value === "expert:general") return "Expert Général";
  return (
    EXPERT_DEFINITIONS[value.slice(7)]?.displayName ?? "Expert indisponible"
  );
}

function associationOptions(selected: string): string {
  const choices = [
    { value: "none", name: "Aucun expert" },
    { value: "expert:general", name: "Expert Général" },
    ...Object.entries(EXPERT_DEFINITIONS)
      .filter(([id]) => id !== "general")
      .map(([id, expert]) => ({
        value: `expert:${id}`,
        name: expert.displayName,
      })),
  ];
  return choices
    .map(
      (choice) =>
        `<option value="${escapeHtml(choice.value)}"${choice.value === selected ? " selected" : ""}>${escapeHtml(choice.name)}</option>`,
    )
    .join("");
}

function renderRoutingForm(
  installationId: number,
  session: WebSession,
  state: ExpertsSettingsState,
): string {
  const { catalog, policy, draft } = state;
  if (!catalog) return "";
  // Une panne ne devient jamais une politique vide : pas de choix éditables
  // ni de propositions tant que les associations enregistrées sont inconnues.
  if (policy === undefined) {
    return `<div class="mapping-table"><table><thead><tr><th>Label GitHub</th><th>Expert IA</th></tr></thead><tbody>${catalog.labels.map((label) => `<tr><td><code>${escapeHtml(label.name)}</code><small>${escapeHtml(label.description?.trim() || "Aucune description.")}</small></td><td>Indisponible</td></tr>`).join("")}</tbody></table></div>`;
  }
  const rows = buildRoutingLabelRows(catalog, policy, draft);
  const fields = rows
    .map((row) => {
      let origin = "Association non enregistrée.";
      if (row.proposed && row.selection === "expert:general")
        origin = "Expert Général proposé ; association non enregistrée.";
      if (row.savedSelection)
        origin = `Association explicite enregistrée : ${selectionName(row.savedSelection)}.`;
      let description = row.description?.trim() || "Aucune description.";
      if (row.missing)
        description = "Label supprimé : cette association est inactive.";
      return `<tr>
      <td><label for="label_${row.labelId}"><code>${escapeHtml(row.name)}</code>${row.missing ? " — label supprimé" : ""}</label><small>${escapeHtml(description)}</small></td>
      <td><select id="label_${row.labelId}" name="label_${row.labelId}" aria-describedby="origin_${row.labelId}">${associationOptions(row.selection)}</select><small id="origin_${row.labelId}">${escapeHtml(origin)}</small></td>
    </tr>`;
    })
    .join("");
  return `<form method="post" action="/settings/${installationId}/repositories/${catalog.repository.id}/routing/save">
    <input type="hidden" name="_csrf" value="${escapeHtml(session.csrfToken)}">
    <input type="hidden" name="policyVersion" value="${escapeHtml(routingPolicyVersion(policy))}">
    <input type="hidden" name="labelIds" value="${rows.map((row) => row.labelId).join(",")}">
    <div class="mapping-table"><table><thead><tr><th scope="col">Label GitHub</th><th scope="col">Expert IA</th></tr></thead>
    <tbody>${fields || '<tr><td colspan="2">Aucun label dans ce dépôt.</td></tr>'}</tbody></table></div>
    <small>Un label sans correspondance enregistrée utilise l’expert Général. Rien n’est sauvegardé à l’ouverture de la page.</small>
    <div class="actions"><button type="submit">Enregistrer les correspondances</button></div>
  </form>`;
}

export function renderExpertsSettings(
  installationId: number,
  session: WebSession,
  state?: ExpertsSettingsState,
): string {
  let selector = "<p>Aucun dépôt accessible à cette installation.</p>";
  if (state?.repositories.length) {
    selector = `<form method="get" action="/settings/${installationId}#experts" class="repository-selector">
      <label for="repositoryId">Dépôt</label>
      <select id="repositoryId" name="repositoryId">${state.repositories.map((repository) => `<option value="${repository.id}"${repository.id === state.repositoryId ? " selected" : ""}>${escapeHtml(`${repository.owner}/${repository.name}`)}</option>`).join("")}</select>
    </form>`;
  } else if (!state) {
    selector = "<p>Rechargez les paramètres pour afficher les dépôts.</p>";
  } else if (state.error) {
    selector = "";
  }
  return `<section class="card" id="experts"><h2>Experts IA</h2>
    ${selector}
    ${state?.error ? `<div class="notice error" role="alert">${escapeHtml(state.error)}</div>` : ""}
    ${state?.saved ? '<div class="notice success">Les correspondances ont été enregistrées.</div>' : ""}
    ${state ? renderRoutingForm(installationId, session, state) : ""}
    <small>La sauvegarde ne lance aucune revue.</small>
    ${renderExpertLinks(installationId)}
  </section>`;
}
