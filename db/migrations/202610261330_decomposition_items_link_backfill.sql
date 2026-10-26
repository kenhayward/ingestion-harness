-- A delivered conversion item's link in the target, for items settled before the API took a
-- sink's `map` entry as the document's own (`linkOf` in apps/api/src/bridge/register.ts): from
-- its register entry's last receipt, the written entry of kind `document` or `map` with a URL,
-- of several the one that is the receipt's map component, else the first. Never a topic's or an
-- image's. Only items with no link yet; running it again changes nothing.
UPDATE decomposition_items i
   SET link = (
         SELECT w.entry->>'url'
           FROM decomposition_register r,
                jsonb_array_elements(
                  CASE WHEN jsonb_typeof(r.last_receipt->'written') = 'array'
                       THEN r.last_receipt->'written' ELSE '[]'::jsonb END
                ) WITH ORDINALITY AS w(entry, n)
          WHERE r.id = i.register_entry_id
            AND w.entry->>'kind' IN ('document', 'map')
            AND w.entry->>'url' IS NOT NULL
          ORDER BY EXISTS (
                     SELECT 1
                       FROM jsonb_array_elements(
                              CASE WHEN jsonb_typeof(r.last_receipt->'document'->'components') = 'array'
                                   THEN r.last_receipt->'document'->'components' ELSE '[]'::jsonb END
                            ) AS c(component)
                      WHERE c.component->>'kind' = 'map'
                        AND c.component->>'id' = w.entry->>'id'
                   ) DESC,
                   w.n
          LIMIT 1
       )
 WHERE i.link IS NULL
   AND i.register_entry_id IS NOT NULL
   AND i.outcome IN ('created', 'updated', 'read_back_mismatch');
