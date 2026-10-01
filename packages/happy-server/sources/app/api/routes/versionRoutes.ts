import { z } from "zod";
import { type Fastify } from "../types";
import * as semver from 'semver';
import { ANDROID_UP_TO_DATE, IOS_UP_TO_DATE } from "@/versions";

export function versionRoutes(app: Fastify) {
    app.post('/v1/version', {
        schema: {
            body: z.object({
                platform: z.string(),
                version: z.string(),
                app_id: z.string()
            }),
            response: {
                200: z.object({
                    updateUrl: z.string().nullable()
                })
            }
        }
    }, async (request, reply) => {
        const { platform, version, app_id } = request.body;

        // No upstream store default: the update URL is only ever the
        // operator's own APP_STORE_URL / PLAY_STORE_URL, when configured.
        const appStoreUrl = process.env.APP_STORE_URL?.trim() || null;
        const playStoreUrl = process.env.PLAY_STORE_URL?.trim() || null;

        // Check ios
        if (platform.toLowerCase() === 'ios') {
            if (semver.satisfies(version, IOS_UP_TO_DATE)) {
                reply.send({ updateUrl: null });
            } else {
                reply.send({ updateUrl: appStoreUrl });
            }
            return;
        }

        // Check android
        if (platform.toLowerCase() === 'android') {
            if (semver.satisfies(version, ANDROID_UP_TO_DATE)) {
                reply.send({ updateUrl: null });
            } else {
                reply.send({ updateUrl: playStoreUrl });
            }
            return;
        }

        // Fallbacke
        reply.send({ updateUrl: null });
    });
}