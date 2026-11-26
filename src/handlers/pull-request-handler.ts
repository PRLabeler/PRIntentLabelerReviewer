import type { Context } from "probot";
import { readPullRequestData } from "../github/pr-reader.js";
import { buildAnalysisComment } from "../comments/build-analysis-comment.js";
import { upsertPullRequestComment } from "../github/pr-commenter.js";
import type { LlmProvider } from "../llm/llm-provider.js";
import {
  createEnvironmentLlmProvider,
  createLlmProvider,
} from "../llm/provider-factory.js";
import { buildPullRequestLlmContext } from "../llm/pr-context.js";
import { filterValidSuggestions } from "../labels/label-policy.js";
import {
  resolveLabelMode,
  selectLabelsToApply,
  selectSuggestedLabelsBelowThreshold,
} from "../labels/label-mode.js";
import { removeLabels } from "../labels/label-applier.js";
import { applyAiSuggestedLabels } from "../labels/ai-label-applier.js";
import { createLabelerCheckRun } from "../github/check-run.js";
import {
  MAX_LABELS_TO_APPLY,
  MIN_CONFIDENCE_TO_SUGGEST,
} from "../utils/constants.js";
import type { PullRequestAnalysis } from "../domain/llm-analysis.js";
import type { LlmUsageMetrics } from "../llm/openai-compatible-provider.js";
import { getLlmConfigurationService } from "../configuration/runtime.js";
import { CLASSIFICATION_PROMPT_VERSION } from "../llm/prompt-builder.js";
import { describeLlmFailure } from "../llm/failure-message.js";
import type { CodeReviewResult } from "../domain/code-review.js";
import type { ReviewExpert } from "../review/review-expert.js";
import type { ExpertRoutingPlan } from "../domain/expert-routing.js";
import { getRepositoryRoutingService } from "../configuration/repository-routing-runtime.js";
import { RepositoryRoutingUnavailableError } from "../configuration/repository-routing.js";
import {
  resolveReviewExpert,
  ReviewConfigurationError,
} from "../review/runtime.js";
import {
  buildExpertRoutingPlan,
  InvalidExpertRoutingPolicyError,
} from "../review/expert-routing.js";
import { registeredIntents } from "../review/expert-policies.js";
import { publishIntentReview } from "../github/review-publisher.js";

export async function handlePullRequestEvent(
  context: Context<"pull_request">,
  providerOverride?: LlmProvider | null,
  reviewExpertOverride?: ReviewExpert | null,
): Promise<void> {
  const { action, pull_request, repository } = context.payload;

  const logContext = {
    action,
    owner: repository.owner.login,
    repo: repository.name,
    pullNumber: pull_request.number,
  };

  context.log.info(logContext, "Processing pull request event");

  try {
    const prData = await readPullRequestData(context);

    let analysis: PullRequestAnalysis | null = null;
    let llmFailureReason: string | null = null;
    let provider: LlmProvider | null;

    // Journalise les jetons réellement facturés par le fournisseur retenu,
    // quel qu'il soit, afin de valider notre estimation locale du budget.
    const onUsage = (usage: LlmUsageMetrics) =>
      context.log.info({ ...logContext, ...usage }, "LLM token usage measured");

    // Le fournisseur doit être connu avant la construction du contexte : c'est
    // sa fenêtre de jetons qui décide combien de fichiers on peut envoyer.
    if (providerOverride !== undefined) {
      provider = providerOverride;
    } else {
      const installationId = context.payload.installation?.id;
      const configurationService = getLlmConfigurationService();

      try {
        const configuration =
          installationId && configurationService
            ? await configurationService.resolve(installationId)
            : null;
        provider = configuration
          ? createLlmProvider(configuration, onUsage)
          : createEnvironmentLlmProvider(onUsage);

        if (configuration && provider) {
          context.log.info(
            {
              ...logContext,
              installationId,
              llmProvider: configuration.provider,
              llmModel: configuration.model,
              contextWindowTokens: provider.tokenBudget?.contextWindowTokens,
              promptTokenBudget: provider.tokenBudget?.promptTokenBudget,
            },
            "Installation LLM configuration loaded",
          );
        }
      } catch (configurationError) {
        // Une indisponibilité de PostgreSQL ne doit pas neutraliser la
        // configuration locale.
        provider = createEnvironmentLlmProvider(onUsage);
        context.log.warn(
          {
            ...logContext,
            installationId,
            error:
              configurationError instanceof Error
                ? configurationError.message
                : configurationError,
          },
          "Failed to load installation LLM configuration; using environment fallback",
        );
      }
    }

    const llmContext = buildPullRequestLlmContext(prData, {
      tokenBudget: provider?.tokenBudget,
    });
    context.log.info(
      {
        ...logContext,
        selectedFilesCount: llmContext.selectedFilesCount,
        summaryOnlyFilesCount: llmContext.summaryOnlyFilesCount,
        // Détail par fichier sélectionné : permet de vérifier immédiatement
        // qu'un lockfile, un snapshot ou un fichier généré n'est jamais
        // réellement envoyé au LLM (seul le rôle "include-patch" doit apparaître).
        selectedFiles: llmContext.selectedFiles.map((ranked) => ({
          filename: ranked.file.filename,
          role: ranked.role,
          score: ranked.score,
          contentPolicy: ranked.contentPolicy,
          reasons: ranked.reasons,
        })),
        contextLimitTokens: llmContext.promptBudget.contextLimitTokens,
        estimatedTotalTokens:
          llmContext.promptBudget.finalPromptEstimatedTokens +
          llmContext.promptBudget.responseReserveTokens,
        estimatedNonPatchTokens:
          llmContext.promptBudget.nonPatchEstimatedTokens,
        availablePatchTokens: llmContext.promptBudget.availablePatchTokens,
        allocatedPatchTokens: llmContext.promptBudget.allocatedPatchTokens,
        patchAllocations: llmContext.promptBudget.files,
        truncatedFiles: llmContext.promptBudget.files
          .filter((file) => file.truncated)
          .map((file) => file.filename),
        promptVersion: CLASSIFICATION_PROMPT_VERSION,
      },
      "Filtered LLM context built",
    );

    if (llmContext.repositoryLabels.length === 0) {
      analysis = {
        suggestions: [],
        summary: "No repository labels are available.",
      };
      context.log.info(
        { ...logContext, promptVersion: CLASSIFICATION_PROMPT_VERSION },
        "No candidate repository labels, skipping LLM classification",
      );
    } else if (provider) {
      try {
        const raw = await provider.classifyPullRequest(llmContext);
        analysis = {
          ...raw,
          suggestions: filterValidSuggestions(
            raw.suggestions,
            llmContext.repositoryLabels,
            MIN_CONFIDENCE_TO_SUGGEST,
            MAX_LABELS_TO_APPLY,
          ),
        };
        context.log.info(
          {
            ...logContext,
            suggestions: analysis.suggestions.map((s) => s.name),
          },
          "LLM label suggestions generated",
        );
      } catch (llmError) {
        llmFailureReason = describeLlmFailure(llmError);
        context.log.warn(
          {
            ...logContext,
            // Le type distingue un rejet HTTP, une réponse vide (modèle à
            // raisonnement ayant épuisé son plafond) et une sortie non conforme.
            errorType: llmError instanceof Error ? llmError.name : "Unknown",
            error: llmError instanceof Error ? llmError.message : llmError,
            promptVersion: CLASSIFICATION_PROMPT_VERSION,
          },
          "LLM call failed, posting comment without suggestions",
        );
      }
    } else {
      llmFailureReason =
        "Aucun fournisseur LLM n'est configuré pour cette installation.";
      context.log.warn(
        logContext,
        "No LLM configuration available, skipping LLM classification",
      );
    }

    const mode = resolveLabelMode(process.env.LABEL_MODE);
    let appliedLabels: string[] = [];
    let intentReview: CodeReviewResult | null = null;
    let intentReviewFailure: string | null = null;

    if (analysis && analysis.suggestions.length > 0) {
      const toApply = selectLabelsToApply(analysis.suggestions, mode);
      if (toApply.length > 0 || mode === "auto-high") {
        const labelNames = toApply.map((s) => s.name);
        const toRemove =
          mode === "auto-high"
            ? selectSuggestedLabelsBelowThreshold(
                analysis.suggestions,
                prData.pullRequestLabels,
              )
            : [];

        try {
          if (toRemove.length > 0) {
            await removeLabels(
              context.octokit,
              repository.owner.login,
              repository.name,
              prData.number,
              toRemove,
            );
          }
          if (labelNames.length > 0) {
            await applyAiSuggestedLabels(
              context.octokit,
              repository.owner.login,
              repository.name,
              prData.number,
              labelNames,
            );
          }
          appliedLabels = labelNames;
          context.log.info(
            { ...logContext, mode, appliedLabels, removedLabels: toRemove },
            "Labels applied to pull request",
          );
        } catch (applyError) {
          context.log.warn(
            {
              ...logContext,
              mode,
              error:
                applyError instanceof Error ? applyError.message : applyError,
            },
            "Failed to apply labels, keeping suggestions only",
          );
        }
      }
    }

    const installationId = context.payload.installation?.id;
    const repositoryId = prData.repositoryId;
    let routingPlan: ExpertRoutingPlan | null = null;
    if (analysis && analysis.suggestions.length > 0) {
      try {
        if (
          installationId === undefined ||
          repositoryId === undefined ||
          prData.repositoryLabelCatalog === undefined
        ) {
          throw new InvalidExpertRoutingPolicyError();
        }

        const scope = { installationId, repositoryId };
        // Seule une lecture réussie retournant null autorise le mode historique.
        // Une politique vide reste prioritaire et une panne suspend la revue.
        const policy = await getRepositoryRoutingService().getPolicy(scope);
        routingPlan = buildExpertRoutingPlan({
          scope,
          policy,
          repositoryLabels: prData.repositoryLabelCatalog,
          suggestions: analysis.suggestions,
          availableExpertIds: registeredIntents(),
        });
      } catch (routingError) {
        intentReviewFailure =
          routingError instanceof RepositoryRoutingUnavailableError ||
          routingError instanceof InvalidExpertRoutingPolicyError
            ? routingError.message
            : new RepositoryRoutingUnavailableError().message;
        context.log.warn(
          {
            ...logContext,
            installationId,
            repositoryId,
            error: intentReviewFailure,
          },
          "Review routing failed; review skipped",
        );
      }
    }

    const selectedExpert = routingPlan?.selectedExpert;
    const reviewLogContext = {
      ...logContext,
      installationId,
      repositoryId,
      routingMode: routingPlan?.mode,
      expertId: selectedExpert?.expertId ?? null,
      routingSource: selectedExpert?.source,
      confidence: selectedExpert?.confidence,
      triggeringLabels:
        selectedExpert?.triggeringLabels.map((label) => ({
          labelId: label.labelId,
          name: label.name,
          confidence: label.confidence,
          source: label.source,
        })) ?? [],
    };
    if (routingPlan) {
      context.log.info(reviewLogContext, "Review routing resolved");
    }

    if (selectedExpert) {
      const reviewIntent = selectedExpert.expertId;
      try {
        let reviewExpert = reviewExpertOverride;
        if (reviewExpertOverride === undefined) {
          const selection = await resolveReviewExpert(
            installationId,
            reviewIntent,
            (usage) =>
              context.log.info(
                {
                  ...reviewLogContext,
                  intention: reviewIntent,
                  ...usage,
                },
                "Expert token usage measured",
              ),
          );
          reviewExpert = selection?.expert ?? null;
          if (selection) {
            context.log.info(
              { ...reviewLogContext, ...selection.metadata },
              "Review configuration selected",
            );
          }
        }
        if (reviewExpert) {
          intentReview = await reviewExpert.review(llmContext, reviewIntent);
          context.log.info(
            {
              ...reviewLogContext,
              reviewIntent: intentReview.intent,
              reviewVerdict: intentReview.verdict,
              reviewFindings: intentReview.findings.length,
            },
            "Pull request routed to specialized review expert",
          );
          try {
            await publishIntentReview(context, prData, intentReview);
            context.log.info(
              {
                ...reviewLogContext,
                reviewFindings: intentReview.findings.length,
              },
              "Intent review publication completed",
            );
          } catch (publishError) {
            context.log.warn(
              {
                ...reviewLogContext,
                error:
                  publishError instanceof Error
                    ? publishError.message
                    : publishError,
              },
              "Failed to publish intent review",
            );
          }
        } else {
          intentReviewFailure =
            "Aucune configuration disponible pour cet expert. Configurez-le dans les paramètres de l’installation.";
        }
      } catch (reviewError) {
        intentReviewFailure =
          reviewError instanceof ReviewConfigurationError
            ? reviewError.message
            : describeLlmFailure(reviewError);
        context.log.warn(
          {
            ...reviewLogContext,
            intention: reviewIntent,
            error: intentReviewFailure,
          },
          "Specialized intent review failed",
        );
      }
    }

    const commentBody = buildAnalysisComment(
      prData,
      llmContext,
      analysis,
      appliedLabels,
      llmFailureReason,
      intentReview,
      intentReviewFailure,
    );
    await upsertPullRequestComment(context, prData.number, commentBody);

    // Boutons d'action (Suggest only / Auto-apply high / Auto-apply all).
    // Échec non bloquant : la permission `checks: write` peut manquer.
    try {
      const checkSummary =
        analysis && analysis.suggestions.length > 0
          ? `${analysis.suggestions.length} label(s) suggéré(s) : ${analysis.suggestions
              .map((s) => s.name)
              .join(", ")}.`
          : (llmFailureReason ?? "Aucune suggestion de label pour cette PR.");
      await createLabelerCheckRun(context, pull_request.head.sha, checkSummary);
    } catch (checkError) {
      context.log.warn(
        {
          ...logContext,
          error: checkError instanceof Error ? checkError.message : checkError,
        },
        "Failed to create check run (checks:write manquant ?)",
      );
    }

    context.log.info(
      { ...logContext, mode, appliedLabels },
      "Pull request analysis comment published",
    );
  } catch (error) {
    context.log.error(
      {
        ...logContext,
        error: error instanceof Error ? error.message : error,
      },
      "Failed to process pull request event",
    );
  }
}
