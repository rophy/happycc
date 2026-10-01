import { FeaturesResponseSchema } from "@slopus/happy-wire";
import { type Fastify } from "../types";
import type { PublicFeatures } from "@/app/features/featuresConfig";

export function featuresRoutes(app: Fastify, features: PublicFeatures) {
    app.get('/v1/features', {
        preHandler: app.authenticate,
        schema: {
            response: {
                200: FeaturesResponseSchema,
            },
        },
    }, async (_request, reply) => {
        return reply.send(features);
    });
}
