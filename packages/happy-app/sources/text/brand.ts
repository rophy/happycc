/**
 * Display-time rebranding of translated strings: whole-word, case-sensitive
 * "Happy Coder" becomes the brand's full name and "Happy" its short name.
 * Lowercase "happy" (commands, URLs, package names) and words that merely
 * contain "Happy" stay as they are.
 *
 * It runs on the final string, after interpolation, so a parameter value
 * containing the word "Happy" (e.g. a session or machine name) is rewritten
 * too. That keeps translation functions untouched; the word rarely appears
 * capitalized and standalone in user content.
 */
export interface Brand {
    name: string;
    fullName: string;
}

export const DEFAULT_BRAND: Brand = { name: 'happycc', fullName: 'Happy Corporate Coder' };

// A letter in any script (it has case), a digit or an underscore. Avoids
// Unicode property escapes so it behaves the same on every JS engine.
function isWordChar(c: string | undefined): boolean {
    return c !== undefined && (c.toLowerCase() !== c.toUpperCase() || /[0-9_]/.test(c));
}

export function applyBrand(text: string, brand: Brand): string {
    if (!text.includes('Happy')) {
        return text;
    }
    // One pass, so a brand name that itself contains "Happy" is not rewritten again.
    return text.replace(/Happy( Coder)?/g, (match: string, coder: string | undefined, offset: number) => {
        if (isWordChar(text[offset - 1])) {
            return match;
        }
        if (coder && !isWordChar(text[offset + match.length])) {
            return brand.fullName;
        }
        // "Happy" alone, or followed by " Coder…" that is part of a longer word.
        return isWordChar(text[offset + 5]) ? match : brand.name + match.slice(5);
    });
}
