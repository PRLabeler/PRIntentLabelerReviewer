import { describe, expect, it, vi } from "vitest";
import { listAllPages } from "../src/github/pagination.js";

describe("listAllPages", () => {
  it("utilise Octokit.paginate lorsque disponible", async () => {
    const method = vi.fn();
    const paginate = vi.fn().mockResolvedValue([{ id: 1 }, { id: 2 }]);

    const result = await listAllPages({ paginate }, method, { per_page: 100 });

    expect(result).toEqual([{ id: 1 }, { id: 2 }]);
    expect(paginate).toHaveBeenCalledWith(method, { per_page: 100 });
    expect(method).not.toHaveBeenCalled();
  });

  it("accepte un client minimal sans paginate pour les tests", async () => {
    const method = vi.fn().mockResolvedValue({ data: [{ id: 1 }] });

    const result = await listAllPages({}, method, { per_page: 100 });

    expect(result).toEqual([{ id: 1 }]);
    expect(method).toHaveBeenCalledWith({ per_page: 100 });
  });

  it("lit aussi l'enveloppe des dépôts avec un client minimal", async () => {
    const method = vi.fn().mockResolvedValue({
      data: { total_count: 2, repositories: [{ id: 1 }, { id: 2 }] },
    });

    expect(await listAllPages({}, method, { per_page: 100 })).toEqual([
      { id: 1 },
      { id: 2 },
    ]);
  });

  it.each([false, true])(
    "propage les erreurs, paginate disponible : %s",
    async (withPaginate) => {
      const error = Object.assign(new Error("GitHub inaccessible"), {
        status: 403,
      });
      const method = vi.fn().mockRejectedValue(error);
      const client = withPaginate
        ? { paginate: vi.fn().mockRejectedValue(error) }
        : {};

      await expect(
        listAllPages(client, method, { per_page: 100 }),
      ).rejects.toBe(error);
    },
  );
});
