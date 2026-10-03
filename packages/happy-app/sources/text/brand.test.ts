import { describe, expect, it } from 'vitest';
import { applyBrand, DEFAULT_BRAND } from './brand';

const acme = { name: 'Acme', fullName: 'Acme Coder Pro' };

describe('applyBrand', () => {
    it('replaces the product names as whole words', () => {
        expect(applyBrand('Welcome to Happy Coder!', acme)).toBe('Welcome to Acme Coder Pro!');
        expect(applyBrand('Open Happy on your phone. Happy\'s settings', acme)).toBe('Open Acme on your phone. Acme\'s settings');
        expect(applyBrand('Happy', acme)).toBe('Acme');
        expect(applyBrand('使用 Happy 应用 / Happy应用', acme)).toBe('使用 Acme 应用 / Acme应用');
    });

    it('leaves lowercase, other words and other casing alone', () => {
        const text = 'Run happy auth; Unhappy HappyCoder HAPPY happy.engineering Happyé Happy_x';
        expect(applyBrand(text, acme)).toBe(text);
    });

    it('treats "Happy Coder" inside a longer word as "Happy" plus the rest', () => {
        expect(applyBrand('Happy Coders unite', acme)).toBe('Acme Coders unite');
    });

    it('does not rewrite a brand name that contains "Happy"', () => {
        expect(applyBrand('Happy Coder and Happy', DEFAULT_BRAND)).toBe('Happy Corporate Coder and happycc');
    });

    it('runs on the final string, so interpolated values are rewritten as whole words too', () => {
        const translate = (p: { name: string }) => `Session ${p.name} on Happy`;
        expect(applyBrand(translate({ name: 'happy-mac' }), acme)).toBe('Session happy-mac on Acme');
        expect(applyBrand(translate({ name: 'Unhappy box' }), acme)).toBe('Session Unhappy box on Acme');
        expect(applyBrand(translate({ name: 'Happy box' }), acme)).toBe('Session Acme box on Acme');
    });
});
