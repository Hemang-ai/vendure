import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
    PROJECT_LINK_GITIGNORE_COMMENT,
    PROJECT_LINK_IGNORE_CONTENTS,
    PROJECT_LINK_KEEP_MANIFEST,
    PROJECT_LINK_NESTED_IGNORE_CONTENTS,
    PROJECT_LINK_NESTED_KEEP_MANIFEST,
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

    it('updates the repo-root gitignore for an apps/vendure monorepo', () => {
        const { workspace, project } = vendureMonorepo({ gitignore: 'node_modules\n' });

        const result = ensureProjectLinkGitignore(project);

        expect(result).toEqual({
            kind: 'updated',
            path: path.join(workspace, '.gitignore'),
        });
        expect(fs.existsSync(getProjectLinkGitignorePath(project))).toBe(false);
        expect(fs.readFileSync(path.join(workspace, '.gitignore'), 'utf8')).toBe(
            [
                'node_modules',
                '',
                PROJECT_LINK_GITIGNORE_COMMENT,
                PROJECT_LINK_NESTED_IGNORE_CONTENTS,
                PROJECT_LINK_NESTED_KEEP_MANIFEST,
                '',
            ].join('\n'),
        );
    });

    it('leaves a monorepo root gitignore unchanged when nested rules already apply', () => {
        const original = [
            'node_modules',
            PROJECT_LINK_NESTED_IGNORE_CONTENTS,
            PROJECT_LINK_NESTED_KEEP_MANIFEST,
            '',
        ].join('\n');
        const { workspace, project } = vendureMonorepo({ gitignore: original });

        expect(ensureProjectLinkGitignore(project)).toEqual({
            kind: 'unchanged',
            path: path.join(workspace, '.gitignore'),
        });
        expect(fs.readFileSync(path.join(workspace, '.gitignore'), 'utf8')).toBe(original);
        expect(fs.existsSync(getProjectLinkGitignorePath(project))).toBe(false);
    });

    it('rewrites a repo-root directory ignore so apps/vendure/.vendure/project.json can be committed', () => {
        const { workspace, project } = vendureMonorepo({ gitignore: '.vendure/\n' });

        expect(ensureProjectLinkGitignore(project).kind).toBe('updated');
        expect(fs.readFileSync(path.join(workspace, '.gitignore'), 'utf8')).toBe(
            [
                PROJECT_LINK_NESTED_IGNORE_CONTENTS,
                '',
                PROJECT_LINK_GITIGNORE_COMMENT,
                PROJECT_LINK_NESTED_KEEP_MANIFEST,
                '',
            ].join('\n'),
        );
        expect(fs.existsSync(getProjectLinkGitignorePath(project))).toBe(false);
    });

    it('prefers an existing apps/vendure gitignore over the repo root', () => {
        const { workspace, project } = vendureMonorepo({ gitignore: 'node_modules\n' });
        fs.writeFileSync(getProjectLinkGitignorePath(project), 'dist\n');

        const result = ensureProjectLinkGitignore(project);

        expect(result).toEqual({
            kind: 'updated',
            path: getProjectLinkGitignorePath(project),
        });
        expect(fs.readFileSync(getProjectLinkGitignorePath(project), 'utf8')).toContain(
            PROJECT_LINK_IGNORE_CONTENTS,
        );
        expect(fs.readFileSync(getProjectLinkGitignorePath(project), 'utf8')).toContain(
            PROJECT_LINK_KEEP_MANIFEST,
        );
        expect(fs.readFileSync(path.join(workspace, '.gitignore'), 'utf8')).toBe('node_modules\n');
    });

    it('fixes a blocking repo-root directory ignore when the package already has local rules', () => {
        const { workspace, project } = vendureMonorepo({ gitignore: '.vendure/\n' });
        const packageIgnore = [
            PROJECT_LINK_IGNORE_CONTENTS,
            PROJECT_LINK_KEEP_MANIFEST,
            '',
        ].join('\n');
        fs.writeFileSync(getProjectLinkGitignorePath(project), packageIgnore);

        expect(ensureProjectLinkGitignore(project).kind).toBe('updated');
        expect(fs.readFileSync(path.join(workspace, '.gitignore'), 'utf8')).toContain(
            PROJECT_LINK_NESTED_IGNORE_CONTENTS,
        );
        expect(fs.readFileSync(path.join(workspace, '.gitignore'), 'utf8')).toContain(
            PROJECT_LINK_NESTED_KEEP_MANIFEST,
        );
        expect(fs.readFileSync(getProjectLinkGitignorePath(project), 'utf8')).toBe(packageIgnore);
    });

    it('rewrites a path-specific directory ignore so the manifest can be committed', () => {
        const { workspace, project } = vendureMonorepo({ gitignore: 'apps/vendure/.vendure/\n' });

        expect(ensureProjectLinkGitignore(project).kind).toBe('updated');
        expect(fs.readFileSync(path.join(workspace, '.gitignore'), 'utf8')).toContain(
            PROJECT_LINK_NESTED_IGNORE_CONTENTS,
        );
        expect(fs.readFileSync(path.join(workspace, '.gitignore'), 'utf8')).toContain(
            PROJECT_LINK_NESTED_KEEP_MANIFEST,
        );
        expect(fs.readFileSync(path.join(workspace, '.gitignore'), 'utf8')).not.toContain(
            'apps/vendure/.vendure/',
        );
    });

    it('accepts path-specific repo-root rules for apps/vendure', () => {
        const original = ['apps/vendure/.vendure/*', '!apps/vendure/.vendure/project.json', ''].join('\n');
        const { workspace, project } = vendureMonorepo({ gitignore: original });

        expect(ensureProjectLinkGitignore(project)).toEqual({
            kind: 'unchanged',
            path: path.join(workspace, '.gitignore'),
        });
        expect(fs.readFileSync(path.join(workspace, '.gitignore'), 'utf8')).toBe(original);
    });

    it('writes nested rules when apply runs in nested mode', () => {
        expect(applyProjectLinkGitignoreRules('node_modules\n', 'nested')).toBe(
            [
                'node_modules',
                '',
                PROJECT_LINK_GITIGNORE_COMMENT,
                PROJECT_LINK_NESTED_IGNORE_CONTENTS,
                PROJECT_LINK_NESTED_KEEP_MANIFEST,
                '',
            ].join('\n'),
        );
    });
});

function temporaryDirectory(): string {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vendure-console-gitignore-'));
    temporaryDirectories.push(directory);
    return fs.realpathSync(directory);
}

function vendureMonorepo(options: { gitignore?: string } = {}): { workspace: string; project: string } {
    const workspace = temporaryDirectory();
    fs.ensureDirSync(path.join(workspace, '.git'));
    fs.writeJsonSync(path.join(workspace, 'package.json'), { private: true });
    if (options.gitignore !== undefined) {
        fs.writeFileSync(path.join(workspace, '.gitignore'), options.gitignore);
    }
    const project = path.join(workspace, 'apps', 'vendure');
    fs.ensureDirSync(project);
    fs.writeJsonSync(path.join(project, 'package.json'), {
        dependencies: { '@vendure/core': '3.7.2' },
    });
    return { workspace, project: fs.realpathSync(project) };
}
