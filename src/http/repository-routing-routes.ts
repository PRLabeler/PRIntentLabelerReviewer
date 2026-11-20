import express, {
  type ErrorRequestHandler,
  type Request,
  type Response,
  type Router,
} from "express";
import type { WebSession } from "../auth/web-auth.js";
import { getGitHubOAuthService } from "../auth/runtime.js";
import { getLlmConfigurationService } from "../configuration/runtime.js";
import { getRepositoryRoutingService } from "../configuration/repository-routing-runtime.js";
import {
  RepositoryRoutingSchemaMissingError,
  RepositoryRoutingValidationError,
} from "../configuration/repository-routing.js";
import {
  RepositoryNotAccessibleError,
  type InstallationRepositoryReader,
} from "../github/installation-repository-reader.js";
import {
  csrfMatches,
  parsePositiveInteger,
  readCookie,
  SESSION_COOKIE,
} from "./configuration-request.js";
import { renderErrorPage } from "./html.js";
import {
  parseRoutingForm,
  RoutingFormError,
} from "./repository-routing-form.js";
import type { ExpertsSettingsState } from "./repository-routing-page.js";
import { renderSettingsPage } from "./settings-page.js";

export type RoutingRepositoryReader = Pick<
  InstallationRepositoryReader,
  "listRepositories" | "readRepositoryLabels"
>;
type RoutingAccess = { installationId: number; session: WebSession };

async function authorize(
  req: Request,
  res: Response,
): Promise<RoutingAccess | null> {
  res.setHeader("Cache-Control", "no-store");
  const installationId = parsePositiveInteger(req.params.installationId);
  let session: WebSession | null = null;
  try {
    const oauth = getGitHubOAuthService();
    const token = readCookie(req, SESSION_COOKIE);
    if (oauth && token) session = await oauth.getSession(token);
  } catch {
    res
      .status(503)
      .send(
        renderErrorPage("Le service d’authentification est indisponible.", 503),
      );
    return null;
  }
  if (!session && req.method === "GET") {
    res.redirect(
      installationId
        ? `/auth/github?installation_id=${installationId}`
        : "/auth/github",
    );
    return null;
  }
  if (
    !session ||
    !installationId ||
    !session.installationIds.includes(installationId) ||
    (req.method !== "GET" && !csrfMatches(session, req.body?._csrf))
  ) {
    res
      .status(403)
      .send(renderErrorPage("Autorisation invalide ou expirée.", 403));
    return null;
  }
  return { installationId, session };
}

function githubFailure(error: unknown): { error: string; status: number } {
  if (error instanceof RepositoryNotAccessibleError)
    return { error: error.message, status: 404 };
  const status = (error as { status?: number } | null)?.status;
  let message =
    "Impossible de récupérer les dépôts ou labels GitHub. Aucune configuration n’a été enregistrée.";
  if (status === 401 || status === 403)
    message =
      "GitHub refuse l’accès aux dépôts ou labels. Vérifiez les accès de l’installation.";
  if (status === 429)
    message = "La limite de requêtes GitHub est atteinte. Réessayez plus tard.";
  return { error: message, status: 502 };
}

function storageFailure(error: unknown): string {
  if (error instanceof RepositoryRoutingSchemaMissingError)
    return error.message;
  return "Le stockage des correspondances est indisponible. Réessayez plus tard.";
}

/** Charge la section intégrée sans modifier les paramètres ni les règles. */
export async function loadExpertsSettings(
  installationId: number,
  requestedRepositoryId: unknown,
  reader?: RoutingRepositoryReader,
): Promise<ExpertsSettingsState> {
  const state: ExpertsSettingsState = { repositories: [] };
  if (!reader)
    return {
      ...state,
      error: "La lecture GitHub n’est pas configurée sur le serveur.",
      status: 503,
    };
  try {
    state.repositories = await reader.listRepositories(installationId);
  } catch (error) {
    return { ...state, ...githubFailure(error) };
  }
  if (requestedRepositoryId === undefined && state.repositories.length === 0)
    return state;
  let repositoryId: number | null = null;
  if (requestedRepositoryId === undefined)
    repositoryId = state.repositories[0].id;
  else if (
    typeof requestedRepositoryId === "string" ||
    typeof requestedRepositoryId === "number"
  )
    repositoryId = parsePositiveInteger(requestedRepositoryId);
  if (
    !repositoryId ||
    !state.repositories.some((repository) => repository.id === repositoryId)
  ) {
    return {
      ...state,
      error: "Ce dépôt n’est pas accessible à cette installation GitHub.",
      status: 404,
    };
  }
  state.repositoryId = repositoryId;
  try {
    state.catalog = await reader.readRepositoryLabels(
      installationId,
      repositoryId,
    );
  } catch (error) {
    return { ...state, ...githubFailure(error) };
  }
  try {
    state.policy = await getRepositoryRoutingService().getPolicy({
      installationId,
      repositoryId,
    });
  } catch (error) {
    return { ...state, error: storageFailure(error), status: 503 };
  }
  return state;
}

async function sendUnifiedSettings(
  res: Response,
  access: RoutingAccess,
  state: ExpertsSettingsState,
): Promise<void> {
  try {
    const service = getLlmConfigurationService();
    if (!service) throw new Error("Configuration indisponible");
    const configuration = await service.getSummary(access.installationId);
    res
      .status(state.status ?? 200)
      .send(renderSettingsPage({ ...access, configuration, experts: state }));
  } catch {
    res
      .status(503)
      .send(
        renderErrorPage(
          state.error ??
            "Les paramètres ne peuvent pas être chargés pour le moment.",
          503,
        ),
      );
  }
}

export function registerRepositoryRoutingRoutes(
  router: Router,
  reader?: RoutingRepositoryReader,
): void {
  const root = "/settings/:installationId/repositories";
  const path = `${root}/:repositoryId/routing`;

  // Compatibilité des anciens liens : aucun parcours séparé n'est proposé.
  router.get(root, async (req, res) => {
    const access = await authorize(req, res);
    if (access) res.redirect(`/settings/${access.installationId}#experts`);
  });
  router.get(path, async (req, res) => {
    const access = await authorize(req, res);
    if (!access) return;
    const state = await loadExpertsSettings(
      access.installationId,
      req.params.repositoryId,
      reader,
    );
    state.saved = req.query.saved === "1" && !!state.policy && !state.error;
    await sendUnifiedSettings(res, access, state);
  });

  const save = async (req: Request, res: Response) => {
    const access = await authorize(req, res);
    if (!access) return;
    const state = await loadExpertsSettings(
      access.installationId,
      req.params.repositoryId,
      reader,
    );
    if (!state.catalog || state.policy === undefined || state.error) {
      await sendUnifiedSettings(res, access, state);
      return;
    }
    const scope = {
      installationId: access.installationId,
      repositoryId: state.catalog.repository.id,
    };
    try {
      state.draft = parseRoutingForm(
        req.body ?? {},
        scope,
        state.catalog,
        state.policy,
      );
      await getRepositoryRoutingService().save({
        ...state.draft,
        catalog: state.catalog,
        githubUserId: access.session.githubUserId,
      });
      res.redirect(
        `/settings/${access.installationId}?repositoryId=${scope.repositoryId}&routingSaved=1#experts`,
      );
    } catch (error) {
      state.status = 503;
      state.error = storageFailure(error);
      if (error instanceof RoutingFormError) {
        state.status = error.status;
        state.error = error.message;
      } else if (error instanceof RepositoryRoutingValidationError) {
        state.status = 400;
        state.error = error.message;
      }
      await sendUnifiedSettings(res, access, state);
    }
  };
  const parseBody = express.urlencoded({
    extended: false,
    limit: "256kb",
    parameterLimit: 10000,
  });
  const formError: ErrorRequestHandler = (error, _req, res, next) => {
    if (res.headersSent) {
      next(error);
      return;
    }
    res.setHeader("Cache-Control", "no-store");
    res
      .status(400)
      .send(
        renderErrorPage(
          "Le formulaire est invalide ou trop volumineux. Aucune correspondance n’a été enregistrée.",
          400,
        ),
      );
  };
  router.post(`${path}/save`, parseBody, save, formError);
}
