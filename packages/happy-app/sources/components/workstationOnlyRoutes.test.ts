import * as fs from 'node:fs';
import Module from 'node:module';
import * as path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

// Bundled images are pulled in with CommonJS `require`, which vi.doMock does not see.
const nodeModule = Module as unknown as { _load: (request: string, ...rest: unknown[]) => unknown };
const originalLoad = nodeModule._load;
beforeAll(() => {
    nodeModule._load = function (request: string, ...rest: unknown[]) {
        if (request.startsWith('@/assets/')) return 1;
        return originalLoad.call(this, request, ...rest);
    };
});
afterAll(() => {
    nodeModule._load = originalLoad;
});

/**
 * The /new and /machine/[id] routes import half the app. Everything except
 * React, the build flag and the placeholder is replaced by an inert stub, and
 * the route's default export is called directly (it holds no hooks), so the
 * test sees exactly which screen the route chooses.
 */
const ROUTES = {
    new: path.resolve(__dirname, '../app/(app)/new/index.tsx'),
    machine: path.resolve(__dirname, '../app/(app)/machine/[id].tsx'),
};
const KEEP = new Set(['react', '@/config', '@/components/NotAvailableInBuild']);

function stub(): any {
    const fn = function () { return stub(); };
    return new Proxy(fn, {
        get: (_target, prop) => (prop === 'then' ? undefined : prop === Symbol.toPrimitive ? () => '' : stub()),
        apply: () => stub(),
        construct: () => stub(),
    });
}

function stubModule(): any {
    return new Proxy({}, {
        has: () => true,
        get: (_target, prop) => (prop === 'then' ? undefined : prop === '__esModule' ? true : stub()),
    });
}

async function loadRoute(file: string, workstationOnly: boolean) {
    vi.resetModules();
    const source = fs.readFileSync(file, 'utf8');
    const specifiers = new Set([...source.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((match) => match[1]));
    for (const specifier of specifiers) {
        if (!KEEP.has(specifier)) vi.doMock(specifier, () => stubModule());
    }
    vi.doMock('@/config', () => ({ config: {}, workstationOnly }));
    vi.doMock('@/components/NotAvailableInBuild', () => ({ NotAvailableInBuild: function NotAvailableInBuild() { return null; } }));
    const route = await import(/* @vite-ignore */ file);
    const { NotAvailableInBuild } = await import('@/components/NotAvailableInBuild');
    // React.memo(...) keeps the function on `.type`.
    const component = route.default.type ?? route.default;
    return { element: component({}), NotAvailableInBuild };
}

afterEach(() => {
    vi.resetModules();
    vi.doUnmock('@/config');
});

describe.each(Object.entries(ROUTES))('the %s route', (_name, file) => {
    it('renders the not-available screen in the workstation-only build', async () => {
        const { element, NotAvailableInBuild } = await loadRoute(file, true);
        expect(element.type).toBe(NotAvailableInBuild);
    });

    it('renders its real screen when the build allows it', async () => {
        const { element, NotAvailableInBuild } = await loadRoute(file, false);
        expect(element.type).not.toBe(NotAvailableInBuild);
        expect(typeof element.type).toBe('function');
    });
});
