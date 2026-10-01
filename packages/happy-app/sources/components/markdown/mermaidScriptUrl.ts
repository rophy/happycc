/**
 * Resolves the native mermaid renderer's script URL from the raw
 * EXPO_PUBLIC_MERMAID_SCRIPT_URL build value.
 *
 * Third-party services are off unless explicitly configured: native has no
 * built-in CDN fallback. Only an https URL is accepted; a blank, invalid or
 * non-https value is treated as unset so the caller renders a plain code
 * block instead of loading remote script into the WebView.
 */
export function resolveMermaidScriptUrl(rawValue: string | undefined | null): string | null {
    const trimmed = rawValue?.trim();
    if (!trimmed) {
        return null;
    }
    let url: URL;
    try {
        url = new URL(trimmed);
    } catch {
        return null;
    }
    if (url.protocol !== 'https:') {
        return null;
    }
    // Normalised href percent-encodes quotes and angle brackets, so the value
    // can be interpolated into the WebView's <script src="..."> safely.
    return url.href;
}
