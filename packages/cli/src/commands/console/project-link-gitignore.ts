import fs from 'fs-extra';
import path from 'node:path';

import { detectMonorepoStructure } from '../../utilities/monorepo-utils';

import { PROJECT_LINK_MANIFEST_RELATIVE_PATH, findGitRoot } from './project-link-manifest';

export const PROJECT_LINK_GITIGNORE_RELATIVE_PATH = '.gitignore';
const PROJECT_LINK_MANIFEST_PATH = PROJECT_LINK_MANIFEST_RELATIVE_PATH.split(path.sep).join('/');
const PROJECT_LINK_DIRECTORY = path.posix.dirname(PROJECT_LINK_MANIFEST_PATH);
export const PROJECT_LINK_IGNORE_CONTENTS = `${PROJECT_LINK_DIRECTORY}/*`;
export const PROJECT_LINK_KEEP_MANIFEST = `!${PROJECT_LINK_MANIFEST_PATH}`;
export const PROJECT_LINK_NESTED_IGNORE_CONTENTS = `**/${PROJECT_LINK_IGNORE_CONTENTS}`;
export const PROJECT_LINK_NESTED_KEEP_MANIFEST = `!**/${PROJECT_LINK_MANIFEST_PATH}`;
export const PROJECT_LINK_GITIGNORE_COMMENT =
    '# Commit the identity-only Project Link Manifest. Keep all other local Vendure state ignored.';

export type ProjectLinkGitignoreMode = 'local' | 'nested';

export type ProjectLinkGitignoreResult =
    | { kind: 'unchanged'; path: string }
    | { kind: 'created'; path: string }
    | { kind: 'updated'; path: string }
    | { kind: 'failed'; path: string; reason: string };

interface GitignoreFile {
    path: string;
    content: string;
}

interface AncestorGitignore extends GitignoreFile {
    needsUpdate: boolean;
}

export function getProjectLinkGitignorePath(projectRoot: string): string {
    return path.join(projectRoot, PROJECT_LINK_GITIGNORE_RELATIVE_PATH);
}

export function ensureProjectLinkGitignore(projectRoot: string): ProjectLinkGitignoreResult {
    const projectGitignorePath = getProjectLinkGitignorePath(projectRoot);
    let target = projectGitignorePath;

    try {
        if (!fs.existsSync(projectGitignorePath)) {
            const ancestor = findAncestorGitignore(projectRoot);
            if (ancestor) {
                target = ancestor.path;
                return ancestor.needsUpdate
                    ? ensureAncestorGitignore(projectRoot, ancestor)
                    : { kind: 'unchanged', path: ancestor.path };
            }
        }
        return ensureSingleGitignore(projectGitignorePath, 'local');
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return { kind: 'failed', path: target, reason };
    }
}

export function applyProjectLinkGitignoreRules(
    content: string,
    mode: ProjectLinkGitignoreMode = 'local',
): string {
    if (mode === 'nested' ? hasNestedCoverage(content) : hasLocalCoverage(content)) {
        return content;
    }

    const ignoreRule = mode === 'nested' ? PROJECT_LINK_NESTED_IGNORE_CONTENTS : PROJECT_LINK_IGNORE_CONTENTS;
    const keepRule = mode === 'nested' ? PROJECT_LINK_NESTED_KEEP_MANIFEST : PROJECT_LINK_KEEP_MANIFEST;
    const newline = detectNewline(content);
    const lines = content.split(/\r?\n/);
    let sawIgnoreContents = false;
    let sawKeepManifest = false;
    let changed = false;

    const nextLines = lines.map(line => {
        const pattern = ignorePattern(line);
        if (!pattern) {
            return line;
        }
        if (mode === 'nested' ? isNestedIgnoreContents(pattern) : isAnyIgnoreContents(pattern)) {
            sawIgnoreContents = true;
            return line;
        }
        if (mode === 'nested' ? isNestedKeepManifest(pattern) : isAnyKeepManifest(pattern)) {
            sawKeepManifest = true;
            return line;
        }
        if (isVendureDirectoryRule(pattern)) {
            changed = true;
            sawIgnoreContents = true;
            return ignoreRule;
        }
        return line;
    });

    const missing: string[] = [];
    if (!sawIgnoreContents) {
        missing.push(ignoreRule);
    }
    if (!sawKeepManifest) {
        missing.push(keepRule);
    }

    let output = nextLines.join(newline);
    if (missing.length > 0) {
        output = appendRuleBlock(output, missing, newline);
    } else if (changed) {
        output = ensureTrailingNewline(output, newline);
    }
    return output;
}

function findAncestorGitignore(projectRoot: string): AncestorGitignore | undefined {
    const gitRoot = findGitRoot(projectRoot);
    const monorepo = detectMonorepoStructure(projectRoot);
    if (!gitRoot || !monorepo.isMonorepo || path.resolve(monorepo.root ?? '') !== path.resolve(gitRoot)) {
        return undefined;
    }

    let deepestFile: GitignoreFile | undefined;
    let directoryIgnored: boolean | undefined;
    let current = path.dirname(projectRoot);
    while (isWithin(gitRoot, current)) {
        const gitignorePath = path.join(current, PROJECT_LINK_GITIGNORE_RELATIVE_PATH);
        if (fs.existsSync(gitignorePath) && fs.statSync(gitignorePath).isFile()) {
            const content = fs.readFileSync(gitignorePath, 'utf8');
            deepestFile ??= { path: gitignorePath, content };
            const projectPath = posixRelative(current, projectRoot);
            if (deepestFile.path === gitignorePath && hasTargetedCoverage(content, projectPath)) {
                return { ...deepestFile, needsUpdate: false };
            }
            directoryIgnored ??= vendureDirectoryState(content, projectPath);
            if (directoryIgnored === true) {
                return { ...deepestFile, needsUpdate: true };
            }
        }
        if (current === gitRoot) {
            break;
        }
        current = path.dirname(current);
    }
    return undefined;
}

function ensureAncestorGitignore(projectRoot: string, file: GitignoreFile): ProjectLinkGitignoreResult {
    const projectPath = posixRelative(path.dirname(file.path), projectRoot);
    const vendurePath = `${projectPath}/${PROJECT_LINK_DIRECTORY}`;
    const rules = [`!${vendurePath}/`, `${vendurePath}/*`, `!${vendurePath}/project.json`];
    const next = appendRuleBlock(file.content, rules, detectNewline(file.content));
    fs.writeFileSync(file.path, next, 'utf8');
    return { kind: 'updated', path: file.path };
}

function ensureSingleGitignore(
    gitignorePath: string,
    mode: ProjectLinkGitignoreMode,
): ProjectLinkGitignoreResult {
    if (!fs.existsSync(gitignorePath)) {
        fs.writeFileSync(gitignorePath, createdGitignoreContents(mode), 'utf8');
        return { kind: 'created', path: gitignorePath };
    }

    const raw = fs.readFileSync(gitignorePath, 'utf8');
    const next = applyProjectLinkGitignoreRules(raw, mode);
    if (next === raw) {
        return { kind: 'unchanged', path: gitignorePath };
    }

    fs.writeFileSync(gitignorePath, next, 'utf8');
    return { kind: 'updated', path: gitignorePath };
}

function vendureDirectoryState(content: string, projectPath: string): boolean | undefined {
    let ignored: boolean | undefined;
    for (const line of content.split(/\r?\n/)) {
        const pattern = ignorePattern(line);
        if (!pattern) {
            continue;
        }
        const negated = pattern.startsWith('!');
        const normalized = stripRootAnchor(pattern.replace(/^!/, '')).replace(/\/$/, '');
        if (
            normalized === PROJECT_LINK_DIRECTORY ||
            normalized === `**/${PROJECT_LINK_DIRECTORY}` ||
            normalized === `${projectPath}/${PROJECT_LINK_DIRECTORY}`
        ) {
            ignored = !negated;
        }
    }
    return ignored;
}

function hasTargetedCoverage(content: string, projectPath: string): boolean {
    const vendurePath = `${projectPath}/${PROJECT_LINK_DIRECTORY}`;
    const patterns = new Set(
        content
            .split(/\r?\n/)
            .map(ignorePattern)
            .filter((pattern): pattern is string => pattern !== undefined),
    );
    return (
        patterns.has(`!${vendurePath}/`) &&
        patterns.has(`${vendurePath}/*`) &&
        patterns.has(`!${vendurePath}/project.json`)
    );
}

function createdGitignoreContents(mode: ProjectLinkGitignoreMode): string {
    const rules =
        mode === 'nested'
            ? [PROJECT_LINK_NESTED_IGNORE_CONTENTS, PROJECT_LINK_NESTED_KEEP_MANIFEST]
            : [PROJECT_LINK_IGNORE_CONTENTS, PROJECT_LINK_KEEP_MANIFEST];
    return `${[PROJECT_LINK_GITIGNORE_COMMENT, ...rules].join('\n')}\n`;
}

function hasLocalCoverage(content: string): boolean {
    return hasRuleCoverage(content, isAnyIgnoreContents, isAnyKeepManifest);
}

function hasNestedCoverage(content: string): boolean {
    return hasRuleCoverage(content, isNestedIgnoreContents, isNestedKeepManifest);
}

function hasRuleCoverage(
    content: string,
    isIgnore: (pattern: string) => boolean,
    isKeep: (pattern: string) => boolean,
): boolean {
    let sawIgnoreContents = false;
    let sawKeepManifest = false;
    for (const line of content.split(/\r?\n/)) {
        const pattern = ignorePattern(line);
        if (pattern && isIgnore(pattern)) {
            sawIgnoreContents = true;
        }
        if (pattern && isKeep(pattern)) {
            sawKeepManifest = true;
        }
    }
    return sawIgnoreContents && sawKeepManifest && !hasVendureDirectoryIgnore(content);
}

function hasVendureDirectoryIgnore(content: string): boolean {
    return content.split(/\r?\n/).some(line => {
        const pattern = ignorePattern(line);
        return pattern !== undefined && isVendureDirectoryRule(pattern);
    });
}

function appendRuleBlock(content: string, rules: string[], newline: string): string {
    let next = content;
    if (next.length > 0 && !next.endsWith('\n')) {
        next += newline;
    }
    if (next.length > 0 && !/(?:\r?\n){2}$/.test(next)) {
        next += newline;
    }
    return `${next}${[PROJECT_LINK_GITIGNORE_COMMENT, ...rules].join(newline)}${newline}`;
}

function ensureTrailingNewline(content: string, newline: string): string {
    return content.length === 0 || content.endsWith('\n') ? content : `${content}${newline}`;
}

function detectNewline(content: string): string {
    return content.includes('\r\n') ? '\r\n' : '\n';
}

function ignorePattern(line: string): string | undefined {
    const trimmed = line.trim();
    return trimmed.length === 0 || trimmed.startsWith('#') ? undefined : trimmed;
}

function isAnyIgnoreContents(pattern: string): boolean {
    return isLocalIgnoreContents(pattern) || isNestedIgnoreContents(pattern);
}

function isLocalIgnoreContents(pattern: string): boolean {
    return /^\.vendure\/\*\*?$/.test(stripRootAnchor(pattern));
}

function isNestedIgnoreContents(pattern: string): boolean {
    return /^\*\*\/\.vendure\/\*\*?$/.test(pattern);
}

function isAnyKeepManifest(pattern: string): boolean {
    return isLocalKeepManifest(pattern) || isNestedKeepManifest(pattern);
}

function isLocalKeepManifest(pattern: string): boolean {
    return /^!\.vendure\/project\.json$/.test(pattern.replace(/^!\/(?=\.)/, '!'));
}

function isNestedKeepManifest(pattern: string): boolean {
    return /^!\*\*\/\.vendure\/project\.json$/.test(pattern);
}

function isVendureDirectoryRule(pattern: string): boolean {
    if (pattern.startsWith('!')) {
        return false;
    }
    return /^(?:\*\*\/)?\.vendure\/?$/.test(stripRootAnchor(pattern));
}

function stripRootAnchor(pattern: string): string {
    return pattern.startsWith('/') ? pattern.slice(1) : pattern;
}

function posixRelative(from: string, to: string): string {
    return path.relative(from, to).split(path.sep).join('/');
}

function isWithin(parent: string, candidate: string): boolean {
    const relative = path.relative(parent, candidate);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
