import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
    PROJECT_LINK_GITIGNORE_COMMENT,
    PROJECT_LINK_IGNORE_CONTENTS,
    PROJECT_LINK_KEEP_MANIFEST,
    applyProjectLinkGitignoreRules,
    ensureProjectLinkGitignore,
    getProjectLinkGitignorePath,
} from './project-link-gitignore';

const temporaryDirectories: string[] = [];

afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
        fs.removeSync(directory);
    }
});

describe('Project Link gitignore', () => {
    it('creates the project gitignore when it is missing', () => {
        const root = temporaryDirectory();

        expect(ensureProjectLinkGitignore(root)).toEqual({
            kind: 'created',
            path: getProjectLinkGitignorePath(root),
        });
        expect(fs.readFileSync(getProjectLinkGitignorePath(root), 'utf8')).toBe(
            `${PROJECT_LINK_GITIGNORE_COMMENT}\n${PROJECT_LINK_IGNORE_CONTENTS}\n${PROJECT_LINK_KEEP_MANIFEST}\n`,
        );
    });

    it('leaves an already-correct gitignore unchanged', () => {
        const root = temporaryDirectory();
        const original = [
            'node_modules',
            PROJECT_LINK_GITIGNORE_COMMENT,
            PROJECT_LINK_IGNORE_CONTENTS,
            PROJECT_LINK_KEEP_MANIFEST,
            '',
        ].join('\n');
        fs.writeFileSync(getProjectLinkGitignorePath(root), original);

        expect(ensureProjectLinkGitignore(root)).toEqual({
            kind: 'unchanged',
            path: getProjectLinkGitignorePath(root),
        });
        expect(fs.readFileSync(getProjectLinkGitignorePath(root), 'utf8')).toBe(original);
    });

    it('appends missing rules to an existing gitignore', () => {
        const root = temporaryDirectory();
        fs.writeFileSync(getProjectLinkGitignorePath(root), 'node_modules\ndist\n');

        expect(ensureProjectLinkGitignore(root).kind).toBe('updated');
        expect(fs.readFileSync(getProjectLinkGitignorePath(root), 'utf8')).toBe(
            [
                'node_modules',
                'dist',
                '',
                PROJECT_LINK_GITIGNORE_COMMENT,
                PROJECT_LINK_IGNORE_CONTENTS,
                PROJECT_LINK_KEEP_MANIFEST,
                '',
            ].join('\n'),
        );
    });

    it('adds only the un-ignore rule when contents are already ignored', () => {
        expect(applyProjectLinkGitignoreRules('.vendure/*\n')).toBe(
            ['.vendure/*', '', PROJECT_LINK_GITIGNORE_COMMENT, PROJECT_LINK_KEEP_MANIFEST, ''].join('\n'),
        );
    });

    it('rewrites a directory ignore so the manifest can be committed', () => {
        expect(applyProjectLinkGitignoreRules('.vendure/\n')).toBe(
            [
                PROJECT_LINK_IGNORE_CONTENTS,
                '',
                PROJECT_LINK_GITIGNORE_COMMENT,
                PROJECT_LINK_KEEP_MANIFEST,
                '',
            ].join('\n'),
        );
        expect(applyProjectLinkGitignoreRules('.vendure\n!.vendure/project.json\n')).toBe(
            `${PROJECT_LINK_IGNORE_CONTENTS}\n${PROJECT_LINK_KEEP_MANIFEST}\n`,
        );
    });

    it('accepts root-anchored and nested equivalent rules', () => {
        expect(applyProjectLinkGitignoreRules('/.vendure/*\n!/.vendure/project.json\n')).toBe(
            '/.vendure/*\n!/.vendure/project.json\n',
        );
        expect(applyProjectLinkGitignoreRules('**/.vendure/**\n!**/.vendure/project.json\n')).toBe(
            '**/.vendure/**\n!**/.vendure/project.json\n',
        );
    });

    it('preserves CRLF when updating an existing file', () => {
        expect(applyProjectLinkGitignoreRules('node_modules\r\n')).toBe(
            [
                'node_modules',
                '',
                PROJECT_LINK_GITIGNORE_COMMENT,
                PROJECT_LINK_IGNORE_CONTENTS,
                PROJECT_LINK_KEEP_MANIFEST,
                '',
            ].join('\r\n'),
        );
    });

    it('does not fail the caller when the gitignore path cannot be written', () => {
        const root = temporaryDirectory();
        fs.ensureDirSync(getProjectLinkGitignorePath(root));

        const result = ensureProjectLinkGitignore(root);

        expect(result.kind).toBe('failed');
        expect(result.path).toBe(getProjectLinkGitignorePath(root));
        expect(fs.statSync(getProjectLinkGitignorePath(root)).isDirectory()).toBe(true);
    });
});

function temporaryDirectory(): string {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vendure-console-gitignore-'));
    temporaryDirectories.push(directory);
    return fs.realpathSync(directory);
}
