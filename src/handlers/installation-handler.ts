import type { Context } from "probot";
import { getLlmConfigurationService } from "../configuration/runtime.js";
import { getExpertConfigurationService } from "../configuration/expert-configuration-runtime.js";
import { getExpertPromptStore } from "../configuration/expert-prompts.js";
import { getRepositoryRoutingService } from "../configuration/repository-routing-runtime.js";

export async function handleInstallationDeleted(
  context: Context<"installation">,
): Promise<void> {
  const installationId = context.payload.installation.id;
  // Chaque nettoyage est tenté même si un autre service est indisponible.
  try {
    const classifier = getLlmConfigurationService();
    if (classifier) {
      await classifier.delete(installationId);
      context.log.info(
        { installationId },
        "Deleted LLM configuration for uninstalled app",
      );
    }
  } catch {
    context.log.error(
      { installationId },
      "Failed to delete LLM configuration after uninstall",
    );
  }
  try {
    const deletedCount =
      await getExpertConfigurationService().deleteForInstallation(
        installationId,
      );
    context.log.info(
      { installationId, deletedCount },
      "Deleted expert configurations for uninstalled app",
    );
  } catch {
    context.log.error(
      { installationId },
      "Failed to delete expert configurations after uninstall",
    );
  }
  try {
    const deletedCount =
      await getRepositoryRoutingService().deleteForInstallation(
        installationId,
        context.payload.sender?.id,
      );
    context.log.info(
      { installationId, deletedCount },
      "Deleted repository routing policies for uninstalled app",
    );
  } catch {
    context.log.error(
      { installationId },
      "Failed to delete repository routing policies after uninstall",
    );
  }
  try {
    const promptStore = getExpertPromptStore();
    if (promptStore) {
      const deletedCount =
        await promptStore.deleteForInstallation(installationId);
      context.log.info(
        { installationId, deletedCount },
        "Deleted expert prompt configurations for uninstalled app",
      );
    }
  } catch {
    context.log.error(
      { installationId },
      "Failed to delete expert prompt configurations after uninstall",
    );
  }
}
