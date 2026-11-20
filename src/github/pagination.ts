// Octokit normalise l'enveloppe des dépôts en tableau pendant paginate.
// Le client minimal doit pouvoir lire cette même enveloppe sans paginate.
type ListPage<T> = { data: T[] | { repositories: T[] } };
type ListMethod<T, TParameters> = (
  parameters: TParameters,
) => Promise<ListPage<T>>;

type OptionalPaginate = {
  paginate?: (method: unknown, parameters: unknown) => Promise<unknown[]>;
};

/**
 * Utilise la pagination Octokit en production. Le repli sur une page garde les
 * petits mocks de tests et les clients Octokit minimaux compatibles.
 */
export async function listAllPages<T, TParameters>(
  octokit: unknown,
  method: ListMethod<T, TParameters>,
  parameters: TParameters,
): Promise<T[]> {
  const client = octokit as OptionalPaginate;
  if (typeof client.paginate === "function") {
    return (await client.paginate(method, parameters)) as T[];
  }

  const response = await method(parameters);
  if (Array.isArray(response.data)) return response.data;
  return response.data.repositories;
}
