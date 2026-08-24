import { z } from 'zod';

export const chatMessageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant']),
  content: z.string().min(1),
});

export const chatCompletionSchema = z.object({
  model: z.string().min(1),
  messages: z.array(chatMessageSchema).min(1),
  temperature: z.number().min(0).max(2).optional(),
  max_tokens: z.number().int().positive().optional(),
  stream: z.boolean().default(false),
  // opt out per request, a caller who benchmarked one model may prefer an
  // error over a different model's answer
  fallback: z.boolean().optional(),
  // false skips reading the cache but still writes the answer, since wanting a
  // fresh answer is not a reason to deny it to everybody else. 'semantic' opts
  // into similarity lookup, which serves the wrong answer about half the time
  // near the threshold (adr 0010), so the caller has to ask for that risk
  cache: z.union([z.boolean(), z.literal('semantic')]).optional(),
});

export type ChatCompletionBody = z.infer<typeof chatCompletionSchema>;
