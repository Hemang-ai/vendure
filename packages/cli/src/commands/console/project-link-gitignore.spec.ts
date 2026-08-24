import fs from 'fs-extra';
import { spawnSync } from 'node:child_process';
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

    it('uses the project gitignore in an apps/vendure monorepo', () => {
        const { workspace, project } = vendureMonorepo({ gitignore: 'node_modules\n' });

        const result = ensureProjectLinkGitignore(project);

        expect(result).toEqual({
            kind: 'created',
            path: getProjectLinkGitignorePath(project),
        });
        expect(fs.readFileSync(getProjectLinkGitignorePath(project), 'utf8')).toBe(
            `${PROJECT_LINK_GITIGNORE_COMMENT}\n${PROJECT_LINK_IGNORE_CONTENTS}\n${PROJECT_LINK_KEEP_MANIFEST}\n`,
        );
        expect(fs.readFileSync(path.join(workspace, '.gitignore'), 'utf8')).toBe('node_modules\n');
        expectGitIgnored(workspace, project, '.vendure/project.json', false);
        expectGitIgnored(workspace, project, '.vendure/cache.db', true);
    });

    it('uses the deepest gitignore when an intermediate file also ignores Vendure state', () => {
        const original = ['node_modules', PROJECT_LINK_NESTED_IGNORE_CONTENTS, ''].join('\n');
        const { workspace, project } = vendureMonorepo({ gitignore: original });
        const appsGitignore = path.join(workspace, 'apps', '.gitignore');
        fs.writeFileSync(appsGitignore, `${PROJECT_LINK_NESTED_IGNORE_CONTENTS}\n`);

        expect(ensureProjectLinkGitignore(project)).toEqual({
            kind: 'created',
            path: getProjectLinkGitignorePath(project),
        });
        expect(fs.readFileSync(path.join(workspace, '.gitignore'), 'utf8')).toBe(original);
        expect(fs.readFileSync(appsGitignore, 'utf8')).toBe(`${PROJECT_LINK_NESTED_IGNORE_CONTENTS}\n`);
        expectGitIgnored(workspace, project, '.vendure/project.json', false);
        expectGitIgnored(workspace, project, '.vendure/cache.db', true);
    });

    it('adds a project-specific exception to a blocking repo-root directory ignore', () => {
        const { workspace, project } = vendureMonorepo({ gitignore: '.vendure/\n' });

        expect(ensureProjectLinkGitignore(project)).toEqual({
            kind: 'updated',
            path: path.join(workspace, '.gitignore'),
        });
        expect(fs.readFileSync(path.join(workspace, '.gitignore'), 'utf8')).toBe(
            [
                '.vendure/',
                '',
                PROJECT_LINK_GITIGNORE_COMMENT,
                '!apps/vendure/.vendure/',
                'apps/vendure/.vendure/*',
                '!apps/vendure/.vendure/project.json',
                '',
            ].join('\n'),
        );
        expect(fs.existsSync(getProjectLinkGitignorePath(project))).toBe(false);
        expectGitIgnored(workspace, project, '.vendure/project.json', false);
        expectGitIgnored(workspace, project, '.vendure/cache.db', true);
        expect(ensureProjectLinkGitignore(project)).toEqual({
            kind: 'unchanged',
            path: path.join(workspace, '.gitignore'),
        });
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

    it('does not rewrite a directory ignore for an unrelated project', () => {
        const original = 'other-app/.vendure/\n';
        const { workspace, project } = vendureMonorepo({ gitignore: original });

        expect(ensureProjectLinkGitignore(project)).toEqual({
            kind: 'created',
            path: getProjectLinkGitignorePath(project),
        });
        expect(fs.readFileSync(path.join(workspace, '.gitignore'), 'utf8')).toBe(original);
        expectGitIgnored(workspace, path.join(workspace, 'other-app'), '.vendure/project.json', true);
        expectGitIgnored(workspace, project, '.vendure/project.json', false);
    });

    it('does not rely on path-specific rules from an ancestor gitignore', () => {
        const original = ['apps/vendure/.vendure/*', '!apps/vendure/.vendure/project.json', ''].join('\n');
        const { workspace, project } = vendureMonorepo({ gitignore: original });

        expect(ensureProjectLinkGitignore(project)).toEqual({
            kind: 'created',
            path: getProjectLinkGitignorePath(project),
        });
        expect(fs.readFileSync(path.join(workspace, '.gitignore'), 'utf8')).toBe(original);
        expectGitIgnored(workspace, project, '.vendure/project.json', false);
        expectGitIgnored(workspace, project, '.vendure/cache.db', true);
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

    it('does not update an incidental repository outside the project', () => {
        const home = temporaryDirectory();
        initializeGitRepository(home);
        fs.writeFileSync(path.join(home, '.gitignore'), 'node_modules\n');
        const project = path.join(home, 'code', 'my-project');
        fs.ensureDirSync(project);

        expect(ensureProjectLinkGitignore(project)).toEqual({
            kind: 'created',
            path: getProjectLinkGitignorePath(project),
        });
        expect(fs.readFileSync(path.join(home, '.gitignore'), 'utf8')).toBe('node_modules\n');
    });
});

function temporaryDirectory(): string {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vendure-console-gitignore-'));
    temporaryDirectories.push(directory);
    return fs.realpathSync(directory);
}

function vendureMonorepo(options: { gitignore?: string } = {}): { workspace: string; project: string } {
    const workspace = temporaryDirectory();
    initializeGitRepository(workspace);
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

function initializeGitRepository(directory: string): void {
    const result = spawnSync('git', ['init', '--quiet'], { cwd: directory, encoding: 'utf8' });
    if (result.status !== 0) {
        throw new Error(result.stderr);
    }
}

function expectGitIgnored(workspace: string, project: string, relativePath: string, ignored: boolean): void {
    const target = path.join(project, relativePath);
    fs.ensureFileSync(target);
    const result = spawnSync('git', ['check-ignore', '--quiet', '--no-index', target], {
        cwd: workspace,
        encoding: 'utf8',
    });
    expect(result.status, result.stderr).toBe(ignored ? 0 : 1);
}
