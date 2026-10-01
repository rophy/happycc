import { type Fastify } from "../types";
import { type FeaturesConfig, publicFeatures } from "@/app/features/featuresConfig";
import { featuresRoutes } from "./featuresRoutes";
import { githubRoutes } from "./githubRoutes";
import { voiceRoutes } from "./voiceRoutes";

/**
 * Third-party integrations are off unless configured: their routes are not
 * registered at all (404), and GET /v1/features tells clients what is on.
 */
export function integrationRoutes(app: Fastify, features: FeaturesConfig, opts: { webappUrl: string }) {
    featuresRoutes(app, publicFeatures(features));
    if (features.github) {
        githubRoutes(app, { github: features.github, webappUrl: opts.webappUrl });
    }
    if (features.voice) {
        voiceRoutes(app);
    }
}
