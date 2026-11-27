import type { Request, Response, Router } from "express";
import type { WebSession } from "../auth/web-auth.js";
import { getGitHubOAuthService } from "../auth/runtime.js";
import { getExpertConfigurationService } from "../configuration/expert-configuration-runtime.js";
import {
  EXPERT_PROMPT_TOO_LONG_ERROR,
  getExpertPromptStore,
} from "../configuration/expert-prompts.js";
import {
  ExpertConfigurationUnavailableError,
  type TestExpertConfigurationInput,
} from "../configuration/expert-configuration.js";
import {
  assertExpertProvider,
  EXPERT_DEFINITIONS,
  isExpertIntention,
  type ExpertIntention,
} from "../configuration/expert-definitions.js";
import { LlmProviderRequestError } from "../llm/provider-error.js";
import {
  configurationInput,
  csrfMatches,
  parsePositiveInteger,
  readCookie,
  SESSION_COOKIE,
} from "./configuration-request.js";
import { renderErrorPage } from "./html.js";
import { renderExpertSettingsPage } from "./expert-settings-page.js";

type ExpertConfigurationScope = {
  installationId: number;
  intention: ExpertIntention;
  session: WebSession;
};

function sendErrorResponse(
  res: Response,
  status: number,
  message: string,
  json: boolean,
): void {
  if (json) {
    res.status(status).json({ message });
  } else {
    res.status(status).send(renderErrorPage(message, status));
  }
}

async function authorize(
  req: Request,
  res: Response,
  json = false,
): Promise<ExpertConfigurationScope | null> {
  res.setHeader("Cache-Control", "no-store");
  const installationId = parsePositiveInteger(req.params.installationId);
  let session: WebSession | null = null;
  try {
    const oauth = getGitHubOAuthService();
    const token = readCookie(req, SESSION_COOKIE);
    if (oauth && token) {
      session = await oauth.getSession(token);
    }
  } catch {
    sendErrorResponse(
      res,
      503,
      "Le service d’authentification est indisponible.",
      json,
    );
    return null;
  }
  if (!session && req.method === "GET") {
    let authenticationUrl = "/auth/github";
    if (installationId) {
      authenticationUrl += `?installation_id=${installationId}`;
    }
    res.redirect(authenticationUrl);
    return null;
  }
  if (
    !session ||
    !installationId ||
    !session.installationIds.includes(installationId)
  ) {
    sendErrorResponse(res, 403, "Autorisation invalide ou expirée.", json);
    return null;
  }
  if (req.method !== "GET" && !csrfMatches(session, req.body?._csrf)) {
    sendErrorResponse(res, 403, "Autorisation invalide ou expirée.", json);
    return null;
  }
  if (!isExpertIntention(req.params.intention)) {
    sendErrorResponse(
      res,
      404,
      "Cette intention n’est pas configurable.",
      json,
    );
    return null;
  }
  return { installationId, intention: req.params.intention, session };
}

function expertInput(
  scope: ExpertConfigurationScope,
  body: Record<string, unknown>,
): TestExpertConfigurationInput {
  const input = configurationInput(scope.installationId, body);
  const provider = input.provider;
  assertExpertProvider(scope.intention, provider);
  return { ...input, provider, intention: scope.intention };
}

// Messages applicatifs autorisés ; aucune erreur brute d'OAuth, SQL ou API ne
// doit être renvoyée au navigateur, même si elle contient la clé saisie.
const PUBLIC_MESSAGES = new Set([
  "Le fournisseur sélectionné est invalide.",
  "Ce fournisseur n’est pas autorisé pour cet expert.",
  "Le nom du modèle est trop long.",
  "La clé API est trop longue.",
  "L’URL de base est trop longue.",
  "Une URL personnalisée n’est pas autorisée pour cet expert.",
  "La clé API est requise.",
  "Une nouvelle clé API est requise lors du changement de fournisseur.",
  "Le prompt de l’expert est requis.",
  EXPERT_PROMPT_TOO_LONG_ERROR,
]);

function publicMessage(error: unknown, intention: ExpertIntention): string {
  const expertName = EXPERT_DEFINITIONS[intention].displayName;
  let message = "L’opération a échoué. Vérifiez la configuration et réessayez.";
  if (error instanceof LlmProviderRequestError) {
    message = `Le fournisseur a refusé la connexion (${error.status}).`;
  } else if (error instanceof Error && PUBLIC_MESSAGES.has(error.message)) {
    message = error.message;
  }
  return `Expert ${expertName} : ${message}`;
}

export function registerExpertConfigurationRoutes(router: Router): void {
  const path = "/settings/:installationId/experts/:intention";
  router.get(path, async (req, res) => {
    const scope = await authorize(req, res);
    if (!scope) return;
    const expertName = EXPERT_DEFINITIONS[scope.intention].displayName;
    try {
      const [configuration, prompt] = await Promise.all([
        getExpertConfigurationService().getSummary(
          scope.installationId,
          scope.intention,
        ),
        getExpertPromptStore()?.getSummary(
          scope.installationId,
          scope.intention,
        ),
      ]);
      let notice: string | undefined;
      if (req.query.saved === "1") {
        notice = `Configuration de l’expert ${expertName} testée et enregistrée. Elle sera utilisée à la prochaine analyse d’une PR pour laquelle cet expert est sélectionné.`;
      } else if (req.query.deleted === "1") {
        notice = `La configuration de l’expert ${expertName} a été supprimée pour cette installation.`;
      } else if (req.query.promptSaved === "1") {
        notice = `Le prompt de l’expert ${expertName} a été enregistré.`;
      } else if (req.query.promptReset === "1") {
        notice = `Le prompt de l’expert ${expertName} a été réinitialisé par défaut.`;
      }
      res.send(
        renderExpertSettingsPage({
          ...scope,
          configuration,
          prompt,
          notice,
        }),
      );
    } catch {
      sendErrorResponse(
        res,
        503,
        `La configuration de l’expert ${expertName} est indisponible. Réessayez plus tard.`,
        false,
      );
    }
  });

  router.post(
    "/api/installations/:installationId/experts/:intention/llm/test",
    async (req, res) => {
      const scope = await authorize(req, res, true);
      if (!scope) return;
      const expertName = EXPERT_DEFINITIONS[scope.intention].displayName;
      try {
        await getExpertConfigurationService().test(
          expertInput(scope, req.body ?? {}),
        );
        res.json({
          message: `Connexion au fournisseur de l’expert ${expertName} réussie. Aucune configuration enregistrée par ce test.`,
        });
      } catch (error) {
        sendErrorResponse(
          res,
          error instanceof ExpertConfigurationUnavailableError ? 503 : 400,
          publicMessage(error, scope.intention),
          true,
        );
      }
    },
  );

  router.post(`${path}/save`, async (req, res) => {
    const scope = await authorize(req, res);
    if (!scope) return;
    const expertName = EXPERT_DEFINITIONS[scope.intention].displayName;
    try {
      await getExpertConfigurationService().save({
        ...expertInput(scope, req.body ?? {}),
        githubUserId: scope.session.githubUserId,
      });
      res.redirect(
        `/settings/${scope.installationId}/experts/${scope.intention}?saved=1`,
      );
    } catch (error) {
      if (error instanceof ExpertConfigurationUnavailableError) {
        sendErrorResponse(
          res,
          503,
          `Le service de configuration de l’expert ${expertName} est indisponible.`,
          false,
        );
        return;
      }
      try {
        const [configuration, prompt] = await Promise.all([
          getExpertConfigurationService().getSummary(
            scope.installationId,
            scope.intention,
          ),
          getExpertPromptStore()?.getSummary(
            scope.installationId,
            scope.intention,
          ),
        ]);
        res.status(400).send(
          renderExpertSettingsPage({
            ...scope,
            configuration,
            prompt,
            error: publicMessage(error, scope.intention),
          }),
        );
      } catch {
        sendErrorResponse(
          res,
          503,
          `Impossible de charger la configuration de l’expert ${expertName}.`,
          false,
        );
      }
    }
  });

  router.post(`${path}/delete`, async (req, res) => {
    const scope = await authorize(req, res);
    if (!scope) return;
    const expertName = EXPERT_DEFINITIONS[scope.intention].displayName;
    try {
      await getExpertConfigurationService().delete(
        scope.installationId,
        scope.intention,
        scope.session.githubUserId,
      );
      res.redirect(
        `/settings/${scope.installationId}/experts/${scope.intention}?deleted=1`,
      );
    } catch {
      sendErrorResponse(
        res,
        503,
        `Impossible de supprimer la configuration de l’expert ${expertName}.`,
        false,
      );
    }
  });

  router.post(`${path}/prompt/save`, async (req, res) => {
    const scope = await authorize(req, res);
    if (!scope) return;
    const expertName = EXPERT_DEFINITIONS[scope.intention].displayName;
    const promptStore = getExpertPromptStore();
    if (!promptStore) {
      sendErrorResponse(
        res,
        503,
        "La persistance des prompts n’est pas activée.",
        false,
      );
      return;
    }
    try {
      await promptStore.save({
        installationId: scope.installationId,
        intention: scope.intention,
        systemPrompt: req.body?.systemPrompt,
        githubUserId: scope.session.githubUserId,
      });
      res.redirect(
        `/settings/${scope.installationId}/experts/${scope.intention}?promptSaved=1#expert-prompt`,
      );
    } catch (error) {
      try {
        const [configuration, existingPrompt] = await Promise.all([
          getExpertConfigurationService().getSummary(
            scope.installationId,
            scope.intention,
          ),
          promptStore.getSummary(scope.installationId, scope.intention),
        ]);
        const submittedPrompt =
          typeof req.body?.systemPrompt === "string"
            ? req.body.systemPrompt
            : existingPrompt.systemPrompt;
        res.status(400).send(
          renderExpertSettingsPage({
            ...scope,
            configuration,
            prompt: { ...existingPrompt, systemPrompt: submittedPrompt },
            error: publicMessage(error, scope.intention),
          }),
        );
      } catch {
        sendErrorResponse(
          res,
          503,
          `Impossible d’enregistrer le prompt de l’expert ${expertName}.`,
          false,
        );
      }
    }
  });

  router.post(`${path}/prompt/reset`, async (req, res) => {
    const scope = await authorize(req, res);
    if (!scope) return;
    const expertName = EXPERT_DEFINITIONS[scope.intention].displayName;
    const promptStore = getExpertPromptStore();
    if (!promptStore) {
      sendErrorResponse(
        res,
        503,
        "La persistance des prompts n’est pas activée.",
        false,
      );
      return;
    }
    try {
      await promptStore.reset(scope.installationId, scope.intention);
      res.redirect(
        `/settings/${scope.installationId}/experts/${scope.intention}?promptReset=1#expert-prompt`,
      );
    } catch {
      sendErrorResponse(
        res,
        503,
        `Impossible de réinitialiser le prompt de l’expert ${expertName}.`,
        false,
      );
    }
  });
}
