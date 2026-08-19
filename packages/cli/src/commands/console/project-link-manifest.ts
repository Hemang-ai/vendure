import fs from 'fs-extra';
import { randomUUID } from 'node:crypto';
import * as fsPromises from 'node:fs/promises';
import path from 'node:path';

import { MONOREPO_PACKAGE_DIRS } from '../../utilities/monorepo-utils';

export const PROJECT_LINK_MANIFEST_RELATIVE_PATH = path.join('.vendure', 'project.json');

export interface ProjectLinkManifest {
    schemaVersion: 1;
    project: { id: string; name: string };
    account: { id: string; name: string };
    link: { id: string; protocolVersion: 1 };
}

export type ManifestReadResult =
    | { kind: 'missing'; path: string }
    | { kind: 'valid'; path: string; manifest: ProjectLinkManifest }
    | { kind: 'invalid'; path: string; reason: string };

export interface AtomicFileOperations {
    mkdir: typeof fsPromises.mkdir;
    open: typeof fsPromises.open;
    rename: typeof fsPromises.rename;
    unlink: typeof fsPromises.unlink;
}

const defaultFileOperations: AtomicFileOperations = {
    mkdir: fsPromises.mkdir,
    open: fsPromises.open,
    rename: fsPromises.rename,
    unlink: fsPromises.unlink,
};

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function resolveProjectRoot(cwd: string, selectedProject?: string): string {
    const resolvedCwd = realDirectory(cwd, 'Current working directory');
    let projectRoot: string;

    if (selectedProject) {
        projectRoot = realDirectory(path.resolve(resolvedCwd, selectedProject), 'Selected project');
        assertVendureProject(projectRoot);
    } else {
        const nearest = findNearestVendureProject(resolvedCwd);
        if (nearest) {
            projectRoot = nearest;
        } else {
            const candidates = findWorkspaceVendureProjects(resolvedCwd);
            if (candidates.length === 0) {
                throw new Error(
                    'Could not find a Vendure project. Run this command from a project that depends on @vendure/core, or pass --project <path>.',
                );
            }
            if (candidates.length > 1) {
                throw new Error(
                    `Multiple Vendure projects were found:\n${candidates
                        .map(candidate => `   ${candidate}`)
                        .join('\n')}\nRun the command again with --project <path>.`,
                );
            }
            projectRoot = candidates[0];
        }
    }

    assertNoCrossRootManifest(resolvedCwd, projectRoot);
    return projectRoot;
}

export function getProjectLinkManifestPath(projectRoot: string): string {
    return path.join(projectRoot, PROJECT_LINK_MANIFEST_RELATIVE_PATH);
}

export function readProjectLinkManifest(projectRoot: string): ManifestReadResult {
    const manifestPath = getProjectLinkManifestPath(projectRoot);
    if (!fs.existsSync(manifestPath)) {
        return { kind: 'missing', path: manifestPath };
    }

    let value: unknown;
    try {
        value = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch {
        return {
            kind: 'invalid',
            path: manifestPath,
            reason: 'The file is not valid JSON.',
        };
    }
    try {
        return { kind: 'valid', path: manifestPath, manifest: parseProjectLinkManifest(value) };
    } catch (error) {
        return {
            kind: 'invalid',
            path: manifestPath,
            reason: error instanceof Error ? error.message : 'The manifest is invalid.',
        };
    }
}

export function parseProjectLinkManifest(value: unknown, expectedLinkId?: string): ProjectLinkManifest {
    const root = exactObject(value, ['schemaVersion', 'project', 'account', 'link'], 'manifest');
    if (root.schemaVersion !== 1) {
        throw new Error('The manifest schemaVersion must be 1.');
    }

    const project = identityObject(root.project, 'project');
    const account = identityObject(root.account, 'account');
    const link = exactObject(root.link, ['id', 'protocolVersion'], 'link');
    const linkId = uuid(link.id, 'link.id');
    if (link.protocolVersion !== 1) {
        throw new Error('The manifest link.protocolVersion must be 1.');
    }
    if (expectedLinkId && linkId !== expectedLinkId) {
        throw new Error('The approved manifest does not match the created link request.');
    }

    return {
        schemaVersion: 1,
        project,
        account,
        link: { id: linkId, protocolVersion: 1 },
    };
}

export async function writeProjectLinkManifestAtomic(
    projectRoot: string,
    manifest: ProjectLinkManifest,
    operations: AtomicFileOperations = defaultFileOperations,
): Promise<string> {
    const manifestPath = getProjectLinkManifestPath(projectRoot);
    const manifestDir = path.dirname(manifestPath);
    const temporaryPath = path.join(manifestDir, `.project-${randomUUID()}.tmp`);
    let handle: Awaited<ReturnType<typeof fsPromises.open>> | undefined;

    try {
        await operations.mkdir(manifestDir, { recursive: true });
        handle = await operations.open(temporaryPath, 'wx', 0o600);
        await handle.writeFile(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
        await handle.sync();
        await handle.close();
        handle = undefined;
        await operations.rename(temporaryPath, manifestPath);
        return manifestPath;
    } catch (error) {
        if (handle) {
            await handle.close().catch(() => undefined);
        }
        await operations.unlink(temporaryPath).catch(() => undefined);
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`Could not write ${manifestPath} atomically: ${detail}`);
    }
}

export function removeProjectLinkManifest(projectRoot: string): void {
    fs.unlinkSync(getProjectLinkManifestPath(projectRoot));
}

function findNearestVendureProject(start: string): string | undefined {
    let current = start;
    while (true) {
        if (hasVendureCoreDependency(current)) {
            return current;
        }
        const parent = path.dirname(current);
        if (parent === current) {
            return undefined;
        }
        current = parent;
    }
}

function findWorkspaceVendureProjects(root: string): string[] {
    const candidates = new Set<string>();
    for (const packageDir of MONOREPO_PACKAGE_DIRS) {
        const container = path.join(root, packageDir);
        if (!fs.existsSync(container)) {
            continue;
        }
        for (const entry of fs.readdirSync(container, { withFileTypes: true })) {
            if (!entry.isDirectory()) {
                continue;
            }
            const candidate = path.join(container, entry.name);
            if (hasVendureCoreDependency(candidate)) {
                candidates.add(fs.realpathSync(candidate));
                continue;
            }
            if (entry.name.startsWith('@')) {
                for (const scopedEntry of fs.readdirSync(candidate, { withFileTypes: true })) {
                    if (!scopedEntry.isDirectory()) {
                        continue;
                    }
                    const scopedCandidate = path.join(candidate, scopedEntry.name);
                    if (hasVendureCoreDependency(scopedCandidate)) {
                        candidates.add(fs.realpathSync(scopedCandidate));
                    }
                }
            }
        }
    }
    return [...candidates].sort();
}

function assertNoCrossRootManifest(cwd: string, projectRoot: string): void {
    const targetManifest = getProjectLinkManifestPath(projectRoot);
    let current = cwd;
    while (true) {
        const ancestorManifest = getProjectLinkManifestPath(current);
        if (
            fs.existsSync(ancestorManifest) &&
            path.resolve(ancestorManifest) !== path.resolve(targetManifest)
        ) {
            throw new Error(
                [
                    'A Project Link Manifest exists outside the selected Vendure project.',
                    `   Existing: ${ancestorManifest}`,
                    `   Selected: ${projectRoot}`,
                    'Run the command from the intended project directory.',
                ].join('\n'),
            );
        }
        const parent = path.dirname(current);
        if (parent === current) {
            return;
        }
        current = parent;
    }
}

function assertVendureProject(projectRoot: string): void {
    if (!hasVendureCoreDependency(projectRoot)) {
        throw new Error(`${projectRoot} is not a Vendure project with a direct @vendure/core dependency.`);
    }
}

function hasVendureCoreDependency(projectRoot: string): boolean {
    const packageJsonPath = path.join(projectRoot, 'package.json');
    if (!fs.existsSync(packageJsonPath)) {
        return false;
    }
    try {
        const packageJson = fs.readJsonSync(packageJsonPath);
        return Boolean(
            packageJson.dependencies?.['@vendure/core'] ??
            packageJson.devDependencies?.['@vendure/core'] ??
            packageJson.optionalDependencies?.['@vendure/core'],
        );
    } catch {
        return false;
    }
}

function realDirectory(directory: string, label: string): string {
    try {
        const realPath = fs.realpathSync(directory);
        if (!fs.statSync(realPath).isDirectory()) {
            throw new Error('not a directory');
        }
        return realPath;
    } catch {
        throw new Error(`${label} does not exist or is not a directory: ${directory}`);
    }
}

function identityObject(value: unknown, label: string): { id: string; name: string } {
    const object = exactObject(value, ['id', 'name'], label);
    return {
        id: uuid(object.id, `${label}.id`),
        name: nonEmptyString(object.name, `${label}.name`),
    };
}

function exactObject(value: unknown, keys: string[], label: string): Record<string, unknown> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new Error(`The ${label} must be an object.`);
    }
    const object = value as Record<string, unknown>;
    const actualKeys = Object.keys(object).sort();
    const expectedKeys = [...keys].sort();
    if (
        actualKeys.length !== expectedKeys.length ||
        actualKeys.some((key, index) => key !== expectedKeys[index])
    ) {
        throw new Error(`The ${label} contains unexpected or missing fields.`);
    }
    return object;
}

function uuid(value: unknown, label: string): string {
    if (typeof value !== 'string' || !UUID_V4_PATTERN.test(value)) {
        throw new Error(`The ${label} must be a UUID v4.`);
    }
    return value;
}

function nonEmptyString(value: unknown, label: string): string {
    if (typeof value !== 'string' || value.trim().length === 0) {
        throw new Error(`The ${label} must be a non-empty string.`);
    }
    return value;
}
