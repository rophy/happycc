import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AxiosError } from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Logger } from './logger';

function makeAxiosError(): AxiosError {
    return new AxiosError(
        'Request failed with status code 401',
        'ERR_BAD_REQUEST',
        {
            method: 'post',
            url: 'https://server.test/v1/auth/refresh',
            headers: { Authorization: 'Bearer SECRET' } as any,
            data: { refreshToken: 'RT' },
        } as any,
        undefined,
        {
            status: 401,
            statusText: 'Unauthorized',
            headers: {} as any,
            config: {} as any,
            data: { refreshToken: 'RT', error: 'invalid_grant' },
        } as any,
    );
}

let dir: string;
let logFile: string;

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'happy-logger-'));
    logFile = join(dir, 'test.log');
});

afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
});

describe('logger axios error sanitization', () => {
    it('never logs the Authorization header or request body of a failed axios request', () => {
        const logger = new Logger(logFile);

        const error = new AxiosError(
            'Request failed with status code 401',
            'ERR_BAD_REQUEST',
            {
                method: 'post',
                url: 'https://server.test/v1/auth/refresh',
                headers: { Authorization: 'Bearer SECRET' } as any,
                data: { refreshToken: 'RT' },
            } as any,
            undefined,
            {
                status: 401,
                statusText: 'Unauthorized',
                headers: {} as any,
                config: {} as any,
                data: { refreshToken: 'RT', error: 'invalid_grant' },
            } as any,
        );

        logger.debug('[AUTH] refresh failed', error);

        const contents = readFileSync(logFile, 'utf8');
        expect(contents).not.toContain('SECRET');
        expect(contents).not.toContain('RT');
        expect(contents).toContain('Request failed with status code 401');
        expect(contents).toContain('ERR_BAD_REQUEST');
        expect(contents).toContain('401');
        expect(contents).toContain('https://server.test/v1/auth/refresh');
    });

    it('sanitizes a mock error object carrying isAxiosError: true, not just real AxiosError instances', () => {
        const logger = new Logger(logFile);

        const fakeAxiosError = {
            isAxiosError: true,
            message: 'socket hang up',
            code: 'ECONNRESET',
            config: {
                method: 'post',
                url: 'https://server.test/v1/auth/refresh',
                headers: { Authorization: 'Bearer SECRET' },
                data: { refreshToken: 'RT' },
            },
            response: undefined,
        };

        logger.debug('[AUTH] refresh failed', fakeAxiosError);

        const contents = readFileSync(logFile, 'utf8');
        expect(contents).not.toContain('SECRET');
        expect(contents).not.toContain('RT');
        expect(contents).toContain('socket hang up');
        expect(contents).toContain('ECONNRESET');
    });

    it('still logs plain, non-axios objects unchanged', () => {
        const logger = new Logger(logFile);
        logger.debug('[TEST] plain object', { foo: 'bar' });

        const contents = readFileSync(logFile, 'utf8');
        expect(contents).toContain('foo');
        expect(contents).toContain('bar');
    });

    it('sanitizes an axios error nested inside a plain object', () => {
        const logger = new Logger(logFile);
        logger.debug('[AUTH] refresh failed', { error: makeAxiosError() });

        const contents = readFileSync(logFile, 'utf8');
        expect(contents).not.toContain('SECRET');
        expect(contents).not.toContain('RT');
        expect(contents).toContain('Request failed with status code 401');
    });

    it('sanitizes an axios error nested inside an array', () => {
        const logger = new Logger(logFile);
        logger.debug('[AUTH] refresh failed', [makeAxiosError(), 'other']);

        const contents = readFileSync(logFile, 'utf8');
        expect(contents).not.toContain('SECRET');
        expect(contents).not.toContain('RT');
    });

    it('sanitizes an axios error carried as Error.cause', () => {
        const logger = new Logger(logFile);
        const wrapper = new Error('refresh failed', { cause: makeAxiosError() });
        logger.debug('[AUTH] refresh failed', wrapper);

        const contents = readFileSync(logFile, 'utf8');
        expect(contents).not.toContain('SECRET');
        expect(contents).not.toContain('RT');
        expect(contents).toContain('refresh failed');
    });

    it('does not throw on a cyclic object, for debug, info and warn', () => {
        const logger = new Logger(logFile);
        const cyclic: Record<string, unknown> = { name: 'cyclic' };
        cyclic.self = cyclic;

        expect(() => logger.debug('[TEST] cyclic', cyclic)).not.toThrow();
        expect(() => logger.info('[TEST] cyclic', cyclic)).not.toThrow();
        expect(() => logger.warn('[TEST] cyclic', cyclic)).not.toThrow();
    });

    it('info() never logs the Authorization header or request body (console + file)', () => {
        const logger = new Logger(logFile);
        const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => { });

        logger.info('[AUTH] refresh failed', { error: makeAxiosError() });

        const consoleOutput = consoleLog.mock.calls.map((call) => call.join(' ')).join('\n');
        const fileContents = readFileSync(logFile, 'utf8');
        for (const leaked of ['SECRET', 'RT']) {
            expect(consoleOutput).not.toContain(leaked);
            expect(fileContents).not.toContain(leaked);
        }

        consoleLog.mockRestore();
    });

    it('warn() never logs the Authorization header or request body (console + file)', () => {
        const logger = new Logger(logFile);
        const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => { });

        logger.warn('[AUTH] refresh failed', { error: makeAxiosError() });

        const consoleOutput = consoleLog.mock.calls.map((call) => call.join(' ')).join('\n');
        const fileContents = readFileSync(logFile, 'utf8');
        for (const leaked of ['SECRET', 'RT']) {
            expect(consoleOutput).not.toContain(leaked);
            expect(fileContents).not.toContain(leaked);
        }

        consoleLog.mockRestore();
    });

    it('does not dig past the depth limit forever on a very deep object', () => {
        const logger = new Logger(logFile);
        let deep: Record<string, unknown> = { leaf: makeAxiosError() };
        for (let i = 0; i < 20; i += 1) {
            deep = { nested: deep };
        }

        expect(() => logger.debug('[TEST] deep', deep)).not.toThrow();
    });
});
