/**
 * PostgREST plafonne ce projet à 1000 lignes par requête (db-max-rows). `.limit(N)`
 * ne l'écrase pas — il faut paginer via `.range()`. Cet helper enchaîne les pages
 * de 1000 jusqu'à épuisement.
 *
 * Usage :
 *   const rows = await fetchAllPaginated((from, to) =>
 *     supabase.from('pairing_instance')
 *       .select('id, ...').in('signature_id', sigIds).order('depart_date')
 *       .range(from, to)
 *   );
 */
type RangeQuery<T> = (from: number, to: number) => PromiseLike<{
  data: T[] | null;
  error: { message: string } | null;
}>;

export async function fetchAllPaginated<T>(
  query: RangeQuery<T>,
  pageSize = 1000,
): Promise<T[]> {
  const all: T[] = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await query(from, from + pageSize - 1);
    if (error) throw new Error(`Supabase pagination: ${error.message}`);
    if (!data?.length) break;
    all.push(...data);
    if (data.length < pageSize) break;
  }
  return all;
}
