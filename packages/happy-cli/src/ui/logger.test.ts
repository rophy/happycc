import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AxiosError } from 'axios';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Logger } from './logger';

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
});
