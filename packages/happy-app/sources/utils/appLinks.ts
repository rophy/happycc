/**
 * Links the build points at: source repository, issue tracker, privacy
 * policy, terms and setup help (`links` in the APP_CONFIG file, see
 * expoConfig.cjs). A row or link whose URL is unset or invalid is hidden;
 * there is no fallback to upstream URLs.
 */
export type AppLinks = {
    githubUrl: string | null;
    issuesUrl: string | null;
    privacyUrl: string | null;
    termsUrl: string | null;
    helpUrl: string | null;
};

/**
 * https, or http only for localhost. The build already refuses http in
 * production; this guards against a hand-edited or malformed manifest.
 */
export function resolveAppLink(rawValue: unknown): string | null {
    if (typeof rawValue !== 'string') {
        return null;
    }
    const trimmed = rawValue.trim();
    if (!trimmed) {
        return null;
    }
    let url: URL;
    try {
        url = new URL(trimmed);
    } catch {
        return null;
    }
    if (url.protocol === 'https:') {
        return url.href;
    }
    if (url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1')) {
        return url.href;
    }
    return null;
}

export function resolveAppLinks(config: { githubUrl?: unknown; issuesUrl?: unknown; privacyUrl?: unknown; termsUrl?: unknown; helpUrl?: unknown }): AppLinks {
    return {
        githubUrl: resolveAppLink(config.githubUrl),
        issuesUrl: resolveAppLink(config.issuesUrl),
        privacyUrl: resolveAppLink(config.privacyUrl),
        termsUrl: resolveAppLink(config.termsUrl),
        helpUrl: resolveAppLink(config.helpUrl),
    };
}

/** Short label for a link row: `owner/repo` on GitHub, else host and path. */
export function linkDetail(url: string): string {
    const parsed = new URL(url);
    const pathname = parsed.pathname.replace(/\/+$/, '');
    return parsed.hostname === 'github.com' ? pathname.replace(/^\//, '') : parsed.host + pathname;
}
