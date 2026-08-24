-- the api key reference is exported as a rank rather than the row uuid, the
-- analysis only counts distinct keys and the uuid identifies a credential row
select 'key-' || dense_rank() over (order by "apiKeyId") as "apiKeyId",
       provider, model, "promptTokens", "completionTokens",
       "costUsd", "costEstimated", "latencyMs", "cacheHit", "cacheKind",
       status, "createdAt"
from "Request"
order by "createdAt";
