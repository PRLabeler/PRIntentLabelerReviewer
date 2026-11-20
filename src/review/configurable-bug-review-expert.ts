import type { BugReviewResult } from "../domain/code-review.js";
import type { PullRequestLlmContext } from "../domain/pull-request-data.js";
import type { BugReviewExpert } from "./bug-review-expert.js";
import { ConfigurableReviewExpert } from "./configurable-review-expert.js";

export class ConfigurableBugReviewExpert
  extends ConfigurableReviewExpert
  implements BugReviewExpert
{
  reviewBugFix(context: PullRequestLlmContext): Promise<BugReviewResult> {
    return this.review(context, "bug");
  }
}
