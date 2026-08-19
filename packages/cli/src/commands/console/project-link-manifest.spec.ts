import fs from 'fs-extra';
import * as fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
    ProjectLinkManifest,
    getProjectLinkManifestPath,
    parseProjectLinkManifest,
    readProjectLinkManifest,
    resolveProjectRoot,
    writeProjectLinkManifestAtomic,
} from './project-link-manifest';

const ACCOUNT_ID = '11111111-1111-4111-8111-111111111111';
const PROJECT_ID = '22222222-2222-4222-8222-222222222222';
const LINK_ID = '33333333-3333-4333-8333-333333333333';
const OTHER_LINK_ID = '44444444-4444-4444-8444-444444444444';

const manifest: ProjectLinkManifest = {
    schemaVersion: 1,
    project: { id: PROJECT_ID, name: 'Storefront' },
    account: { id: ACCOUNT_ID, name: 'Acme' },
    link: { id: LINK_ID, protocolVersion: 1 },
};

const temporaryDirectories: string[] = [];

afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
        fs.removeSync(directory);
    }
});

describe('Project Link Manifest', () => {
    it('parses and reconstructs the exact v1 contract', () => {
        expect(parseProjectLinkManifest(structuredClone(manifest), LINK_ID)).toEqual(manifest);
    });

    it('rejects unexpected fields and a mismatched link ID', () => {
        expect(() => parseProjectLinkManifest({ ...manifest, pollingSecret: 'secret' })).toThrow(
            'unexpected or missing fields',
        );
        expect(() => parseProjectLinkManifest(manifest, OTHER_LINK_ID)).toThrow(
            'does not match the created link request',
        );
    });

    it('reports malformed JSON without including file contents', () => {
        const root = vendureProject();
        const manifestPath = getProjectLinkManifestPath(root);
        fs.ensureDirSync(path.dirname(manifestPath));
        fs.writeFileSync(manifestPath, '{"pollingSecret":"do-not-print"');

        const result = readProjectLinkManifest(root);

        expect(result).toMatchObject({ kind: 'invalid', reason: 'The file is not valid JSON.' });
        expect(JSON.stringify(result)).not.toContain('do-not-print');
    });

    it('resolves the nearest ancestor Vendure project', () => {
        const root = vendureProject();
        const nested = path.join(root, 'src', 'plugins', 'example');
        fs.ensureDirSync(nested);

        expect(resolveProjectRoot(nested)).toBe(root);
    });

    it('resolves one workspace project and rejects ambiguous workspaces', () => {
        const workspace = temporaryDirectory();
        fs.writeJsonSync(path.join(workspace, 'package.json'), { private: true });
        const first = vendureProject(path.join(workspace, 'apps', 'server'));

        expect(resolveProjectRoot(workspace)).toBe(first);

        vendureProject(path.join(workspace, 'packages', 'second-server'));
        expect(() => resolveProjectRoot(workspace)).toThrow('Multiple Vendure projects were found');
    });

    it('uses an explicit project and rejects an ancestor manifest for another root', () => {
        const workspace = temporaryDirectory();
        fs.writeJsonSync(path.join(workspace, 'package.json'), { private: true });
        const selected = vendureProject(path.join(workspace, 'apps', 'server'));
        const ancestorManifest = getProjectLinkManifestPath(workspace);
        fs.ensureDirSync(path.dirname(ancestorManifest));
        fs.writeJsonSync(ancestorManifest, manifest);

        expect(() => resolveProjectRoot(workspace, selected)).toThrow(
            'A Project Link Manifest exists outside the selected Vendure project',
        );
    });

    it('atomically writes a manifest and preserves the old file if rename fails', async () => {
        const root = vendureProject();
        const manifestPath = await writeProjectLinkManifestAtomic(root, manifest);
        expect(fs.readJsonSync(manifestPath)).toEqual(manifest);

        const replacement: ProjectLinkManifest = {
            ...manifest,
            link: { id: OTHER_LINK_ID, protocolVersion: 1 },
        };
        await expect(
            writeProjectLinkManifestAtomic(root, replacement, {
                mkdir: fsPromises.mkdir,
                open: fsPromises.open,
                rename: () => Promise.reject(new Error('simulated rename failure')),
                unlink: fsPromises.unlink,
            }),
        ).rejects.toThrow('simulated rename failure');

        expect(fs.readJsonSync(manifestPath)).toEqual(manifest);
        expect(fs.readdirSync(path.dirname(manifestPath)).filter(name => name.endsWith('.tmp'))).toEqual([]);
    });
});

function temporaryDirectory(): string {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vendure-console-manifest-'));
    temporaryDirectories.push(directory);
    return fs.realpathSync(directory);
}

function vendureProject(directory = temporaryDirectory()): string {
    fs.ensureDirSync(directory);
    fs.writeJsonSync(path.join(directory, 'package.json'), {
        dependencies: { '@vendure/core': '3.7.2' },
    });
    return fs.realpathSync(directory);
}
