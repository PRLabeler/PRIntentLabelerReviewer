import { beforeEach, describe, expect, it, vi } from "vitest";
import { handlePullRequestEvent } from "../src/handlers/pull-request-handler.js";
import app from "../src/index.js";

vi.mock("../src/handlers/pull-request-handler.js", () => ({
  handlePullRequestEvent: vi.fn(),
}));

function registeredHandlers() {
  const on = vi.fn();
  app(
    { on, log: { info: vi.fn() } } as unknown as Parameters<typeof app>[0],
    {},
  );
  return on.mock.calls as Array<
    [string | string[], (context: unknown) => Promise<void>]
  >;
}

function pullRequestCallbackFor(event: string) {
  return registeredHandlers().find(([events]) =>
    ([] as string[]).concat(events).includes(event),
  )?.[1];
}

beforeEach(() => {
  vi.mocked(handlePullRequestEvent).mockReset().mockResolvedValue(undefined);
});

describe("abonnements aux événements de Pull Request", () => {
  it.each([
    "pull_request.opened",
    "pull_request.reopened",
    "pull_request.synchronize",
    "pull_request.edited",
  ])("route %s vers l'analyse de la PR", async (event) => {
    const callback = pullRequestCallbackFor(event);
    expect(callback).toBeTypeOf("function");

    const context = { payload: { action: event.split(".")[1] } };
    await callback!(context);

    expect(handlePullRequestEvent).toHaveBeenCalledTimes(1);
    expect(handlePullRequestEvent).toHaveBeenCalledWith(context);
  });

  it("n'analyse pas une PR fermée", () => {
    expect(pullRequestCallbackFor("pull_request.closed")).toBeUndefined();
  });
});
