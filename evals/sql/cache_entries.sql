select left(prompt, 120) as prompt_head, length(prompt) as prompt_length,
       model, hits, "createdAt", "lastUsedAt"
from "CacheEntry"
order by hits desc, "createdAt";
