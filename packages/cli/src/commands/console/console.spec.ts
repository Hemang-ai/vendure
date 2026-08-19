import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CliCommandExit } from '../../shared/cli-command-exit';

import {
    ConsoleCommandDependencies,
    ConsoleReporter,
    consoleCommand,
    resolveConsoleEndpoints,
} from './console';
import { ProjectLinkManifest, getProjectLinkManifestPath } from './project-link-manifest';

const NOW = Date.parse('2026-08-19T10:00:00.000Z');
const ACCOUNT_ID = '11111111-1111-4111-8111-111111111111';
const PROJECT_ID = '22222222-2222-4222-8222-222222222222';
const LINK_ID = '33333333-3333-4333-8333-333333333333';
const POLLING_SECRET = 'one-time-polling-secret';

const manifest: ProjectLinkManifest = {
    schemaVersion: 1,
    project: { id: PROJECT_ID, name: 'Storefront' },
    account: { id: ACCOUNT_ID, name: 'Acme' },
    link: { id: LINK_ID, protocolVersion: 1 },
};

const temporaryDirectories: string[] = [];

afterEach(() => {
    vi.restoreAllMocks();
    for (const directory of temporaryDirectories.splice(0)) {
        fs.removeSync(directory);
    }
});

describe('console command', () => {
    it('reports missing and unknown actions with examples', async () => {
        const root = vendureProject();
        const first = testDependencies(root, vi.fn());
        const second = testDependencies(root, vi.fn());

        expect(await consoleCommand(undefined, {}, first.dependencies)).toBe(1);
        expect(await consoleCommand('unknown', {}, second.dependencies)).toBe(1);
        expect(first.messages.join('\n')).toContain('vendure console link');
        expect(second.messages.join('\n')).toContain('Unknown console action');
    });

    it('requires paired endpoint overrides and validates origins', () => {
        expect(resolveConsoleEndpoints({})).toEqual({
            consoleUrl: 'https://console.vendure.io',
            apiUrl: 'https://api.vendure.io',
        });
        expect(resolveConsoleEndpoints({ VENDURE_CONSOLE_URL: '', VENDURE_CONSOLE_API_URL: '   ' })).toEqual({
            consoleUrl: 'https://console.vendure.io',
            apiUrl: 'https://api.vendure.io',
        });
        expect(() => resolveConsoleEndpoints({ VENDURE_CONSOLE_URL: 'http://localhost:3000' })).toThrow(
            'Set both',
        );
        expect(() =>
            resolveConsoleEndpoints({
                VENDURE_CONSOLE_URL: 'http://localhost:3000/path',
                VENDURE_CONSOLE_API_URL: 'http://localhost:3001',
            }),
        ).toThrow('without a path');
    });

    it('completes create, pending poll, approval, and atomic manifest write', async () => {
        const root = vendureProject();
        const fetchMock = sequenceFetch(
            jsonResponse(createResponse()),
            jsonResponse({ state: 'pending', expiresAt: expiry() }),
            jsonResponse({ state: 'approved', expiresAt: expiry(), manifest }),
        );
        const test = testDependencies(root, fetchMock);

        expect(await consoleCommand('link', {}, test.dependencies)).toBe(0);

        expect(fs.readJsonSync(getProjectLinkManifestPath(root))).toEqual(manifest);
        expect(fetchMock).toHaveBeenCalledTimes(3);
        expect(fetchMock.mock.calls[1][1]?.body).toBe(JSON.stringify({ pollingSecret: POLLING_SECRET }));
        expect(test.messages.join('\n')).toContain('safe to commit');
    });

    it('prints the safe verification URL and continues when browser launch fails', async () => {
        const root = vendureProject();
        const fetchMock = sequenceFetch(
            jsonResponse(createResponse()),
            jsonResponse({ state: 'approved', expiresAt: expiry(), manifest }),
        );
        const test = testDependencies(root, fetchMock, {
            openUrl: () => Promise.reject(new Error('browser unavailable')),
        });

        expect(await consoleCommand('link', {}, test.dependencies)).toBe(0);
        expect(test.urls).toEqual([`http://localhost:3000/?link=${LINK_ID}`]);
        expect(test.messages.join('\n')).not.toContain(POLLING_SECRET);
    });

    it('does not write a manifest after denial or a malformed approval', async () => {
        const deniedRoot = vendureProject();
        const denied = testDependencies(
            deniedRoot,
            sequenceFetch(
                jsonResponse(createResponse()),
                jsonResponse({ state: 'denied', expiresAt: expiry() }),
            ),
        );
        expect(await consoleCommand('link', {}, denied.dependencies)).toBe(1);
        expect(fs.existsSync(getProjectLinkManifestPath(deniedRoot))).toBe(false);

        const malformedRoot = vendureProject();
        const malformed = testDependencies(
            malformedRoot,
            sequenceFetch(
                jsonResponse(createResponse()),
                jsonResponse({
                    state: 'approved',
                    expiresAt: expiry(),
                    manifest: { ...manifest, pollingSecret: POLLING_SECRET },
                }),
            ),
        );
        expect(await consoleCommand('link', {}, malformed.dependencies)).toBe(1);
        expect(fs.existsSync(getProjectLinkManifestPath(malformedRoot))).toBe(false);
        expect(malformed.messages.join('\n')).not.toContain(POLLING_SECRET);
    });

    it('reports an expired request without writing a manifest', async () => {
        const root = vendureProject();
        const test = testDependencies(
            root,
            sequenceFetch(
                jsonResponse(createResponse()),
                jsonResponse({ state: 'expired', expiresAt: new Date(NOW - 1).toISOString() }),
            ),
        );

        expect(await consoleCommand('link', {}, test.dependencies)).toBe(1);
        expect(test.messages.join('\n')).toContain('request expired');
        expect(fs.existsSync(getProjectLinkManifestPath(root))).toBe(false);
    });

    it('retries transient poll failures and does not retry request creation', async () => {
        const root = vendureProject();
        const fetchMock = sequenceFetch(
            jsonResponse(createResponse()),
            new Response('', { status: 503 }),
            new Response('', { status: 502 }),
            jsonResponse({ state: 'approved', expiresAt: expiry(), manifest }),
        );
        const test = testDependencies(root, fetchMock);

        expect(await consoleCommand('link', {}, test.dependencies)).toBe(0);
        expect(test.sleeps).toEqual([500, 1_000]);

        const createFailure = vi.fn(() =>
            Promise.resolve(new Response('', { status: 503 })),
        ) as unknown as typeof fetch;
        const failed = testDependencies(vendureProject(), createFailure);
        expect(await consoleCommand('link', {}, failed.dependencies)).toBe(1);
        expect(createFailure).toHaveBeenCalledOnce();
    });

    it('never prints the polling secret when polling becomes unreachable', async () => {
        const root = vendureProject();
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce(jsonResponse(createResponse()))
            .mockRejectedValue(new Error(`network error ${POLLING_SECRET}`)) as unknown as typeof fetch;
        const test = testDependencies(root, fetchMock);

        expect(await consoleCommand('link', {}, test.dependencies)).toBe(1);
        expect([...test.messages, ...test.urls].join('\n')).not.toContain(POLLING_SECRET);
        expect(fs.existsSync(getProjectLinkManifestPath(root))).toBe(false);
    });

    it('fails closed for replacement in non-interactive mode and allows --force', async () => {
        const root = vendureProject();
        fs.ensureDirSync(path.dirname(getProjectLinkManifestPath(root)));
        fs.writeJsonSync(getProjectLinkManifestPath(root), manifest);
        const blockedFetch = vi.fn() as unknown as typeof fetch;
        const blocked = testDependencies(root, blockedFetch);

        expect(await consoleCommand('link', {}, blocked.dependencies)).toBe(1);
        expect(blockedFetch).not.toHaveBeenCalled();
        expect(fs.readJsonSync(getProjectLinkManifestPath(root))).toEqual(manifest);

        const replacement = { ...manifest, project: { ...manifest.project, name: 'Replacement' } };
        const allowed = testDependencies(
            root,
            sequenceFetch(
                jsonResponse(createResponse()),
                jsonResponse({ state: 'approved', expiresAt: expiry(), manifest: replacement }),
            ),
        );
        expect(await consoleCommand('link', { force: true }, allowed.dependencies)).toBe(0);
        expect(fs.readJsonSync(getProjectLinkManifestPath(root))).toEqual(replacement);
    });

    it('rethrows CliCommandExit from the prompt so the CLI host owns the exit', async () => {
        const root = vendureProject();
        fs.ensureDirSync(path.dirname(getProjectLinkManifestPath(root)));
        fs.writeJsonSync(getProjectLinkManifestPath(root), manifest);
        const test = testDependencies(root, vi.fn() as unknown as typeof fetch, {
            isNonInteractive: () => false,
            prompt: () => Promise.reject(new CliCommandExit(1)),
        });

        await expect(consoleCommand('link', {}, test.dependencies)).rejects.toBeInstanceOf(CliCommandExit);
        expect(test.messages.join('\n')).not.toContain('requested exit code');
        expect(fs.readJsonSync(getProjectLinkManifestPath(root))).toEqual(manifest);
    });

    it('leaves an existing manifest unchanged when interactive replacement is cancelled', async () => {
        const root = vendureProject();
        fs.ensureDirSync(path.dirname(getProjectLinkManifestPath(root)));
        fs.writeJsonSync(getProjectLinkManifestPath(root), manifest);
        const fetchMock = vi.fn() as unknown as typeof fetch;
        const test = testDependencies(root, fetchMock, {
            isNonInteractive: () => false,
            prompt: () => Promise.resolve(false),
        });

        expect(await consoleCommand('link', {}, test.dependencies)).toBe(0);
        expect(fetchMock).not.toHaveBeenCalled();
        expect(fs.readJsonSync(getProjectLinkManifestPath(root))).toEqual(manifest);
    });

    it('reports linked, unlinked, and malformed status without network access', async () => {
        const root = vendureProject();
        const fetchMock = vi.fn() as unknown as typeof fetch;
        const unlinked = testDependencies(root, fetchMock);
        expect(await consoleCommand('status', {}, unlinked.dependencies)).toBe(0);
        expect(unlinked.messages.join('\n')).toContain('Project: Not linked');

        fs.ensureDirSync(path.dirname(getProjectLinkManifestPath(root)));
        fs.writeJsonSync(getProjectLinkManifestPath(root), manifest);
        const linked = testDependencies(root, fetchMock);
        expect(await consoleCommand('status', {}, linked.dependencies)).toBe(0);
        expect(linked.messages.join('\n')).toContain(`Account: Acme (${ACCOUNT_ID})`);
        expect(linked.messages.join('\n')).toContain('Authentication: Not stored locally');

        fs.writeFileSync(getProjectLinkManifestPath(root), '{invalid');
        const malformed = testDependencies(root, fetchMock);
        expect(await consoleCommand('status', {}, malformed.dependencies)).toBe(1);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('unlinks only the local manifest after explicit confirmation', async () => {
        const root = vendureProject();
        const manifestPath = getProjectLinkManifestPath(root);
        const siblingPath = path.join(path.dirname(manifestPath), 'credentials.json');
        fs.ensureDirSync(path.dirname(manifestPath));
        fs.writeJsonSync(manifestPath, manifest);
        fs.writeFileSync(siblingPath, 'machine-local');
        const test = testDependencies(root, vi.fn() as unknown as typeof fetch);

        expect(await consoleCommand('unlink', { force: true }, test.dependencies)).toBe(0);
        expect(fs.existsSync(manifestPath)).toBe(false);
        expect(fs.readFileSync(siblingPath, 'utf8')).toBe('machine-local');
        expect(fs.existsSync(path.dirname(manifestPath))).toBe(true);
    });

    it('returns an interrupt exit code and leaves no partial manifest', async () => {
        const root = vendureProject();
        const externalAbort = new AbortController();
        const test = testDependencies(
            root,
            sequenceFetch(
                jsonResponse(createResponse()),
                jsonResponse({ state: 'pending', expiresAt: expiry() }),
            ),
            {
                signal: externalAbort.signal,
                sleep: () => {
                    externalAbort.abort();
                    return Promise.resolve();
                },
            },
        );

        expect(await consoleCommand('link', {}, test.dependencies)).toBe(130);
        expect(fs.existsSync(getProjectLinkManifestPath(root))).toBe(false);
        expect(test.messages.join('\n')).toContain('No Project Link Manifest was changed');
    });
});

function testDependencies(
    root: string,
    fetchImplementation: typeof fetch,
    overrides: Partial<ConsoleCommandDependencies> = {},
): {
    dependencies: Partial<ConsoleCommandDependencies>;
    messages: string[];
    sleeps: number[];
    urls: string[];
} {
    const messages: string[] = [];
    const urls: string[] = [];
    const sleeps: number[] = [];
    const reporter: ConsoleReporter = {
        error: message => messages.push(message),
        info: message => messages.push(message),
        success: message => messages.push(message),
        warn: message => messages.push(message),
        url: value => urls.push(value),
    };
    return {
        dependencies: {
            cwd: root,
            env: {
                VENDURE_CLI_NON_INTERACTIVE: 'true',
                VENDURE_CONSOLE_URL: 'http://localhost:3000',
                VENDURE_CONSOLE_API_URL: 'http://localhost:3001',
            },
            fetch: fetchImplementation,
            isNonInteractive: () => true,
            now: () => NOW,
            openUrl: () => Promise.resolve(),
            prompt: () => Promise.resolve(true),
            reporter,
            sleep: milliseconds => {
                sleeps.push(milliseconds);
                return Promise.resolve();
            },
            ...overrides,
        },
        messages,
        sleeps,
        urls,
    };
}

function createResponse() {
    return {
        id: LINK_ID,
        state: 'pending',
        protocolVersion: 1,
        expiresAt: expiry(),
        pollingSecret: POLLING_SECRET,
        verificationPath: `/?link=${LINK_ID}`,
    };
}

function expiry(): string {
    return new Date(NOW + 10 * 60 * 1_000).toISOString();
}

function jsonResponse(value: unknown): Response {
    return new Response(JSON.stringify(value), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
    });
}

function sequenceFetch(...responses: Response[]): ReturnType<typeof vi.fn> {
    const fetchMock = vi.fn();
    for (const response of responses) {
        fetchMock.mockResolvedValueOnce(response);
    }
    return fetchMock;
}

function vendureProject(): string {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vendure-console-command-')));
    temporaryDirectories.push(root);
    fs.writeJsonSync(path.join(root, 'package.json'), {
        dependencies: { '@vendure/core': '3.7.2' },
    });
    return root;
}
