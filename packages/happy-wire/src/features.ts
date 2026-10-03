import * as z from 'zod';

/** GET /v1/features: which server-side integrations this deployment has turned on. */
export const FeaturesResponseSchema = z.object({
    githubConnect: z.boolean(),
    push: z.boolean(),
});

export type FeaturesResponse = z.infer<typeof FeaturesResponseSchema>;
