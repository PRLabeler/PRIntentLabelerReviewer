import { describe, expect, it } from "vitest";
import {
  assertExpertIntention,
  assertExpertProvider,
  EXPERT_DEFINITIONS,
  EXPERT_PROVIDER_NAMES,
  isExpertIntention,
  isExpertProviderName,
} from "../src/configuration/expert-definitions.js";
import { registeredIntents } from "../src/review/expert-policies.js";

describe("définitions des experts", () => {
  it("rend toutes les politiques configurables avec les trois fournisseurs prévus", () => {
    expect(Object.keys(EXPERT_DEFINITIONS)).toEqual(registeredIntents());
    expect(EXPERT_DEFINITIONS.general.displayName).toBe("Général");
    expect(EXPERT_PROVIDER_NAMES).toEqual(["anthropic", "openai", "gemini"]);
    for (const intention of registeredIntents()) {
      expect(isExpertIntention(intention)).toBe(true);
      for (const provider of EXPERT_PROVIDER_NAMES) {
        expect(isExpertProviderName(provider)).toBe(true);
        expect(() => assertExpertProvider(intention, provider)).not.toThrow();
      }
    }
  });

  it.each(["unknown-expert", "BUG", "__proto__", "toString", "", null])(
    "refuse l'intention non active %s",
    (value) => {
      expect(isExpertIntention(value)).toBe(false);
      expect(() => assertExpertIntention(value)).toThrow("pas configurable");
    },
  );

  it.each(["groq", "custom", "xai", "perplexity", "google", undefined])(
    "refuse le fournisseur %s",
    (value) => {
      expect(isExpertProviderName(value)).toBe(false);
      expect(() => assertExpertProvider("bug", value)).toThrow("pas autorisé");
    },
  );
});
