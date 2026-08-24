import { confirm, isCancel, log } from '@clack/prompts';
import { ChildProcess, spawn } from 'node:child_process';

import { CliCommandExit } from '../../shared/cli-command-exit';
import { isNonInteractiveEnvironment, withInteractiveTimeout } from '../../utilities/utils';

import {
    ManifestReadResult,
    ProjectLinkManifest,
    parseProjectLinkManifest,
    readProjectLinkManifest,
    removeProjectLinkManifest,
    resolveProjectRoot,
    writeProjectLinkManifestAtomic,
} from './project-link-manifest';
import { nonEmptyStringValue, objectValue, uuidValue } from './project-link-validation';

const DEFAULT_CONSOLE_URL = 'https://console.vendure.io';
const DEFAULT_CONSOLE_API_URL = 'https://api.vendure.io';
const POLL_INTERVAL_MS = 2_000;
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RETRY_DELAY_MS = 2_000;

export interface ConsoleCommandOptions {
    project?: string;
    force?: boolean;
}

export interface ConsoleReporter {
    error(message: string): void;
    info(message: string): void;
    success(message: string): void;
    warn(message: string): void;
    url(value: string): void;
}

export interface ConsoleCommandDependencies {
    cwd: string;
    env: NodeJS.ProcessEnv;
    fetch: typeof globalThis.fetch;
    isNonInteractive: () => boolean;
    now: () => number;
    openUrl: (url: string) => Promise<void>;
    prompt: (message: string) => Promise<boolean | undefined>;
    reporter: ConsoleReporter;
    signal?: AbortSignal;
    sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

interface ConsoleEndpoints {
    apiUrl: string;
    consoleUrl: string;
}

interface ProjectLinkRequest {
    id: string;
    expiresAt: number;
    pollingSecret: string;
    verificationUrl: string;
}

interface ProjectLinkPollResult {
    state: 'pending' | 'approved' | 'denied' | 'expired';
    expiresAt: number;
    manifest?: ProjectLinkManifest;
}

class ConsoleRequestError extends Error {
    constructor(
        message: string,
        readonly transient: boolean,
    ) {
        super(message);
        this.name = 'ConsoleRequestError';
    }
}

class CommandInterruptedError extends Error {
    constructor(readonly exitCode: number) {
        super('The Console command was interrupted.');
        this.name = 'CommandInterruptedError';
    }
}

const defaultReporter: ConsoleReporter = {
    error: message => log.error(message),
    info: message => log.info(message),
    success: message => log.success(message),
    warn: message => log.warn(message),
    url: value => process.stdout.write(`${value}\n`),
};

function createDefaultDependencies(): ConsoleCommandDependencies {
    return {
        cwd: process.cwd(),
        env: process.env,
        fetch: globalThis.fetch,
        isNonInteractive: () => isNonInteractiveEnvironment(),
        now: () => Date.now(),
        openUrl: openUrlInBrowser,
        prompt: async message => {
            const result = await withInteractiveTimeout(() => confirm({ message }), {
                examples: ['vendure console link --force', 'vendure console unlink --force'],
                helpCommands: ['vendure console --help'],
            });
            return isCancel(result) ? undefined : result;
        },
        reporter: defaultReporter,
        sleep: abortableSleep,
    };
}

export async function consoleCommand(
    action?: string,
    options: ConsoleCommandOptions = {},
    dependencies: Partial<ConsoleCommandDependencies> = {},
): Promise<number> {
    const resolvedDependencies = { ...createDefaultDependencies(), ...dependencies };
    const abortController = new AbortController();
    let interruptedExitCode: number | undefined;
    const onSigint = () => {
        interruptedExitCode = 130;
        abortController.abort();
    };
    const onSigterm = () => {
        interruptedExitCode = 143;
        abortController.abort();
    };
    process.once('SIGINT', onSigint);
    process.once('SIGTERM', onSigterm);
    const externalSignal = dependencies.signal;
    const onExternalAbort = () => abortController.abort();
    if (externalSignal?.aborted) {
        abortController.abort();
    } else {
        externalSignal?.addEventListener('abort', onExternalAbort, { once: true });
    }

    try {
        return await runConsoleCommand(action, options, resolvedDependencies, abortController.signal);
    } catch (error) {
        if (interruptedExitCode !== undefined || error instanceof CommandInterruptedError) {
            const exitCode = interruptedExitCode ?? (error as CommandInterruptedError).exitCode;
            resolvedDependencies.reporter.warn(
                'Console command interrupted. No Project Link Manifest was changed.',
            );
            return exitCode;
        }
        if (error instanceof CliCommandExit) {
            throw error;
        }
        resolvedDependencies.reporter.error(error instanceof Error ? error.message : String(error));
        return 1;
    } finally {
        process.removeListener('SIGINT', onSigint);
        process.removeListener('SIGTERM', onSigterm);
        externalSignal?.removeEventListener('abort', onExternalAbort);
    }
}

async function runConsoleCommand(
    action: string | undefined,
    options: ConsoleCommandOptions,
    dependencies: ConsoleCommandDependencies,
    signal: AbortSignal,
): Promise<number> {
    const normalizedAction = action?.trim().toLowerCase();
    if (!normalizedAction || !['link', 'status', 'unlink'].includes(normalizedAction)) {
        dependencies.reporter.error(
            normalizedAction ? `Unknown console action "${String(action)}".` : 'Missing console action.',
        );
        dependencies.reporter.info(
            'Examples:\n   vendure console link\n   vendure console status\n   vendure console unlink',
        );
        return 1;
    }

    const projectRoot = resolveProjectRoot(dependencies.cwd, options.project, options.force);
    if (normalizedAction === 'status') {
        return status(projectRoot, dependencies.reporter);
    }
    if (normalizedAction === 'unlink') {
        return unlink(projectRoot, options, dependencies);
    }
    return link(projectRoot, options, dependencies, signal);
}

export function resolveConsoleEndpoints(env: NodeJS.ProcessEnv): ConsoleEndpoints {
    const consoleOverride = env.VENDURE_CONSOLE_URL?.trim() || undefined;
    const apiOverride = env.VENDURE_CONSOLE_API_URL?.trim() || undefined;
    if (Boolean(consoleOverride) !== Boolean(apiOverride)) {
        throw new Error(
            'Set both VENDURE_CONSOLE_URL and VENDURE_CONSOLE_API_URL, or unset both to use production.',
        );
    }
    return {
        consoleUrl: baseUrl(consoleOverride ?? DEFAULT_CONSOLE_URL, 'VENDURE_CONSOLE_URL'),
        apiUrl: baseUrl(apiOverride ?? DEFAULT_CONSOLE_API_URL, 'VENDURE_CONSOLE_API_URL'),
    };
}

async function link(
    projectRoot: string,
    options: ConsoleCommandOptions,
    dependencies: ConsoleCommandDependencies,
    signal: AbortSignal,
): Promise<number> {
    const existing = readProjectLinkManifest(projectRoot);
    if (existing.kind !== 'missing') {
        const confirmed = await confirmManifestChange('replace', existing, options, dependencies);
        if (confirmed !== 'confirmed') {
            return confirmed === 'cancelled' ? 0 : 1;
        }
    }

    const endpoints = resolveConsoleEndpoints(dependencies.env);
    const request = await createProjectLink(endpoints, dependencies, signal);
    dependencies.reporter.info('Approve the Project link in your browser.');
    try {
        await dependencies.openUrl(request.verificationUrl);
    } catch {
        dependencies.reporter.warn('Could not open the browser automatically. Open this URL to continue:');
        dependencies.reporter.url(request.verificationUrl);
    }

    const manifest = await waitForApproval(request, endpoints, dependencies, signal);
    throwIfAborted(signal);
    const manifestPath = await writeProjectLinkManifestAtomic(projectRoot, manifest);
    dependencies.reporter.success(`Linked ${manifest.project.name} to ${manifest.account.name}.`);
    dependencies.reporter.info(`Wrote ${manifestPath}`);
    dependencies.reporter.info(
        'This file contains identity metadata only and is safe to commit. Keep every other .vendure file ignored because it may contain machine-local secrets.',
    );
    return 0;
}

function status(projectRoot: string, reporter: ConsoleReporter): number {
    const result = readProjectLinkManifest(projectRoot);
    if (result.kind === 'missing') {
        reporter.info(`Project: Not linked\nManifest: ${result.path}\nAuthentication: Not stored locally`);
        reporter.info(
            'Console authorization happens in the browser; the CLI stores no Console access token.',
        );
        return 0;
    }
    if (result.kind === 'invalid') {
        reporter.error(`Invalid Project Link Manifest at ${result.path}: ${result.reason}`);
        return 1;
    }

    const { manifest } = result;
    reporter.info(
        [
            `Account: ${manifest.account.name} (${manifest.account.id})`,
            `Project: ${manifest.project.name} (${manifest.project.id})`,
            `Schema version: ${manifest.schemaVersion}`,
            `Protocol version: ${manifest.link.protocolVersion}`,
            `Link: ${manifest.link.id}`,
            'Authentication: Not stored locally (browser authorization)',
        ].join('\n'),
    );
    return 0;
}

async function unlink(
    projectRoot: string,
    options: ConsoleCommandOptions,
    dependencies: ConsoleCommandDependencies,
): Promise<number> {
    const existing = readProjectLinkManifest(projectRoot);
    if (existing.kind === 'missing') {
        dependencies.reporter.info(`Project is not linked. No manifest exists at ${existing.path}.`);
        return 0;
    }

    const confirmed = await confirmManifestChange('remove', existing, options, dependencies);
    if (confirmed !== 'confirmed') {
        return confirmed === 'cancelled' ? 0 : 1;
    }
    removeProjectLinkManifest(projectRoot);
    dependencies.reporter.success(`Removed local Project Link Manifest at ${existing.path}.`);
    dependencies.reporter.info('The Console Project and server-side link request were not changed.');
    return 0;
}

async function confirmManifestChange(
    action: 'replace' | 'remove',
    existing: Exclude<ManifestReadResult, { kind: 'missing' }>,
    options: ConsoleCommandOptions,
    dependencies: ConsoleCommandDependencies,
): Promise<'confirmed' | 'cancelled' | 'required'> {
    if (options.force) {
        return 'confirmed';
    }
    if (dependencies.isNonInteractive()) {
        dependencies.reporter.error(
            `Refusing to ${action} ${existing.path} without confirmation in a non-interactive environment.`,
        );
        dependencies.reporter.info(
            `Run vendure console ${action === 'replace' ? 'link' : 'unlink'} --force to confirm this action.`,
        );
        return 'required';
    }

    const detail =
        existing.kind === 'valid'
            ? `${existing.manifest.project.name} in ${existing.manifest.account.name}`
            : `the invalid manifest at ${existing.path}`;
    const result = await dependencies.prompt(
        `${action === 'replace' ? 'Replace' : 'Remove'} the local link for ${detail}?`,
    );
    if (result === undefined) {
        throw new CommandInterruptedError(130);
    }
    if (result !== true) {
        dependencies.reporter.info('No Project Link Manifest changes were made.');
        return 'cancelled';
    }
    return 'confirmed';
}

async function createProjectLink(
    endpoints: ConsoleEndpoints,
    dependencies: ConsoleCommandDependencies,
    signal: AbortSignal,
): Promise<ProjectLinkRequest> {
    const value = await requestJson(
        `${endpoints.apiUrl}/project-links`,
        { method: 'POST' },
        dependencies,
        signal,
    );
    const object = objectValue(value, 'Console returned a malformed project-link response.');
    const id = uuid(object.id, 'project-link id');
    if (object.state !== 'pending' || object.protocolVersion !== 1) {
        throw new Error('Console returned an unsupported Project Link request.');
    }
    const expiresAt = timestamp(object.expiresAt, 'project-link expiry');
    const pollingSecret = nonEmptyString(object.pollingSecret, 'polling secret');
    const verificationPath = nonEmptyString(object.verificationPath, 'verification path');
    if (!verificationPath.startsWith('/') || verificationPath.startsWith('//')) {
        throw new Error('Console returned an invalid verification path.');
    }
    const verificationUrl = new URL(verificationPath, `${endpoints.consoleUrl}/`).toString();
    if (new URL(verificationUrl).origin !== new URL(endpoints.consoleUrl).origin) {
        throw new Error('Console returned a verification URL for an unexpected origin.');
    }
    if (verificationUrl.includes(pollingSecret)) {
        throw new Error('Console returned an unsafe verification URL.');
    }
    return { id, expiresAt, pollingSecret, verificationUrl };
}

async function waitForApproval(
    request: ProjectLinkRequest,
    endpoints: ConsoleEndpoints,
    dependencies: ConsoleCommandDependencies,
    signal: AbortSignal,
): Promise<ProjectLinkManifest> {
    let expiresAt = request.expiresAt;
    while (true) {
        throwIfAborted(signal);
        if (dependencies.now() >= expiresAt) {
            throw new Error('The Project Link request expired. Run vendure console link again.');
        }

        const result = await pollWithRetry(request, expiresAt, endpoints, dependencies, signal);
        expiresAt = result.expiresAt;
        if (result.state === 'approved') {
            if (!result.manifest) {
                throw new Error('Console approved the request without returning a Project Link Manifest.');
            }
            return result.manifest;
        }
        if (result.state === 'denied') {
            throw new Error('The Project Link request was denied in Console.');
        }
        if (result.state === 'expired' || dependencies.now() >= result.expiresAt) {
            throw new Error('The Project Link request expired. Run vendure console link again.');
        }
        await dependencies.sleep(POLL_INTERVAL_MS, signal);
    }
}

async function pollWithRetry(
    request: ProjectLinkRequest,
    expiresAt: number,
    endpoints: ConsoleEndpoints,
    dependencies: ConsoleCommandDependencies,
    signal: AbortSignal,
): Promise<ProjectLinkPollResult> {
    let attempt = 0;
    while (true) {
        if (dependencies.now() >= expiresAt) {
            throw new Error('The Project Link request expired. Run vendure console link again.');
        }
        try {
            const value = await requestJson(
                `${endpoints.apiUrl}/project-links/${encodeURIComponent(request.id)}/poll`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ pollingSecret: request.pollingSecret }),
                },
                dependencies,
                signal,
            );
            return parsePollResult(value, request.id);
        } catch (error) {
            if (!(error instanceof ConsoleRequestError) || !error.transient) {
                throw error;
            }
            const remainingMs = expiresAt - dependencies.now();
            if (remainingMs <= 0) {
                throw new Error('The Project Link request expired. Run vendure console link again.');
            }
            await dependencies.sleep(Math.min(retryDelay(attempt), remainingMs), signal);
            attempt++;
        }
    }
}

function retryDelay(attempt: number): number {
    return Math.min(attempt === 0 ? 500 : attempt * 1_000, MAX_RETRY_DELAY_MS);
}

function parsePollResult(value: unknown, expectedLinkId: string): ProjectLinkPollResult {
    const record = objectValue(value, 'Console returned a malformed Project Link polling response.');
    const state = record.state;
    if (!['pending', 'approved', 'denied', 'expired'].includes(String(state))) {
        throw new Error('Console returned an unknown Project Link state.');
    }
    const result: ProjectLinkPollResult = {
        state: state as ProjectLinkPollResult['state'],
        expiresAt: timestamp(record.expiresAt, 'project-link expiry'),
    };
    if (state === 'approved') {
        result.manifest = parseProjectLinkManifest(record.manifest, expectedLinkId);
    }
    return result;
}

async function requestJson(
    url: string,
    init: RequestInit,
    dependencies: ConsoleCommandDependencies,
    signal: AbortSignal,
): Promise<unknown> {
    throwIfAborted(signal);
    const requestController = new AbortController();
    let timedOut = false;
    const onAbort = () => requestController.abort();
    signal.addEventListener('abort', onAbort, { once: true });
    const timeout = setTimeout(() => {
        timedOut = true;
        requestController.abort();
    }, REQUEST_TIMEOUT_MS);

    let response: Response;
    try {
        response = await dependencies.fetch(url, { ...init, signal: requestController.signal });
    } catch {
        if (signal.aborted) {
            throw new CommandInterruptedError(130);
        }
        throw new ConsoleRequestError(
            timedOut
                ? 'The Vendure Console API request timed out. Check the configured endpoint and try again.'
                : 'Could not reach the Vendure Console API. Check your connection and configured endpoint.',
            true,
        );
    } finally {
        clearTimeout(timeout);
        signal.removeEventListener('abort', onAbort);
    }

    if (!response.ok) {
        throw new ConsoleRequestError(
            `Vendure Console API request failed with HTTP ${response.status}.`,
            response.status >= 500,
        );
    }
    try {
        return await response.json();
    } catch {
        throw new ConsoleRequestError('Vendure Console API returned malformed JSON.', false);
    }
}

function baseUrl(value: string, label: string): string {
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        throw new Error(`${label} must be an absolute HTTP or HTTPS URL.`);
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
        throw new Error(`${label} must be an absolute HTTP or HTTPS URL without credentials.`);
    }
    if (url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
        throw new Error(`${label} must contain only an origin without a path, query, or fragment.`);
    }
    return url.origin;
}

function uuid(value: unknown, label: string): string {
    return uuidValue(value, `Console returned an invalid ${label}.`);
}

function timestamp(value: unknown, label: string): number {
    if (typeof value !== 'string') {
        throw new Error(`Console returned an invalid ${label}.`);
    }
    const result = Date.parse(value);
    if (!Number.isFinite(result)) {
        throw new Error(`Console returned an invalid ${label}.`);
    }
    return result;
}

function nonEmptyString(value: unknown, label: string): string {
    return nonEmptyStringValue(value, `Console returned an invalid ${label}.`);
}

function throwIfAborted(signal: AbortSignal): void {
    if (signal.aborted) {
        throw new CommandInterruptedError(130);
    }
}

function abortableSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        if (signal.aborted) {
            reject(new CommandInterruptedError(130));
            return;
        }
        const timeout = setTimeout(() => {
            signal.removeEventListener('abort', onAbort);
            resolve();
        }, milliseconds);
        const onAbort = () => {
            clearTimeout(timeout);
            reject(new CommandInterruptedError(130));
        };
        signal.addEventListener('abort', onAbort, { once: true });
    });
}

function openUrlInBrowser(url: string): Promise<void> {
    // explorer.exe drops URL query strings, so Windows must go through the url.dll protocol handler.
    const isWindows = process.platform === 'win32';
    const command = process.platform === 'darwin' ? 'open' : isWindows ? 'rundll32' : 'xdg-open';
    const args = isWindows ? ['url.dll,FileProtocolHandler', url] : [url];
    return new Promise((resolve, reject) => {
        let child: ChildProcess;
        try {
            child = spawn(command, args, { detached: true, stdio: 'ignore' });
        } catch (error) {
            reject(error);
            return;
        }
        child.once('error', reject);
        child.once('spawn', () => {
            child.removeListener('error', reject);
            child.unref();
            resolve();
        });
    });
}
