import type { ApplicationFunctionOptions, Probot } from "probot";
import { handlePullRequestEvent } from "./handlers/pull-request-handler.js";
import { handleCheckRunRequestedAction } from "./handlers/check-run-handler.js";
import { handleIssueCommentEdited } from "./handlers/comment-handler.js";
import { registerConfigurationRoutes } from "./http/configuration-routes.js";
import { handleInstallationDeleted } from "./handlers/installation-handler.js";
import { InstallationRepositoryReader } from "./github/installation-repository-reader.js";

export default (app: Probot, options: ApplicationFunctionOptions) => {
  if (options.getRouter) {
    const repositoryReader = new InstallationRepositoryReader(
      (installationId) => app.auth(installationId),
    );
    registerConfigurationRoutes(options.getRouter("/"), repositoryReader);
  }

  app.on(
    ["pull_request.opened", "pull_request.synchronize", "pull_request.edited"],
    async (context) => {
      await handlePullRequestEvent(context);
    },
  );

  app.on("check_run.requested_action", async (context) => {
    await handleCheckRunRequestedAction(context);
  });

  app.on("issue_comment.edited", async (context) => {
    await handleIssueCommentEdited(context);
  });

  app.on("installation.deleted", async (context) => {
    await handleInstallationDeleted(context);
  });

  app.log.info("LLM PR Labeler app loaded");
};
