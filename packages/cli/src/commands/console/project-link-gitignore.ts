import fs from 'fs-extra';
import path from 'node:path';

export const PROJECT_LINK_GITIGNORE_RELATIVE_PATH = '.gitignore';
export const PROJECT_LINK_IGNORE_CONTENTS = '.vendure/*';
export const PROJECT_LINK_KEEP_MANIFEST = '!.vendure/project.json';
export const PROJECT_LINK_NESTED_IGNORE_CONTENTS = '**/.vendure/*';
export const PROJECT_LINK_NESTED_KEEP_MANIFEST = '!**/.vendure/project.json';
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
    scope: 'project' | 'ancestor';
}

export function getProjectLinkGitignorePath(projectRoot: string): string {
    return path.join(projectRoot, PROJECT_LINK_GITIGNORE_RELATIVE_PATH);
}

export function ensureProjectLinkGitignore(projectRoot: string): ProjectLinkGitignoreResult {
    const projectGitignorePath = getProjectLinkGitignorePath(projectRoot);
    try {
        const gitRoot = findGitRoot(projectRoot);
        if (!gitRoot) {
            return ensureSingleGitignore(projectGitignorePath, 'local');
        }
        return ensureGitignoreInRepo(projectRoot, gitRoot);
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return { kind: 'failed', path: projectGitignorePath, reason };
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
        if (isDirectoryIgnore(pattern)) {
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
        changed = true;
    } else if (changed) {
        output = ensureTrailingNewline(output, newline);
    }

    return output;
}

function ensureGitignoreInRepo(projectRoot: string, gitRoot: string): ProjectLinkGitignoreResult {
    const projectGitignorePath = getProjectLinkGitignorePath(projectRoot);
    const chain = collectGitignoreChain(projectRoot, gitRoot);
    const dirty = new Map<string, string>();

    for (const file of chain) {
        if (!hasDirectoryIgnore(file.content)) {
            continue;
        }
        const next = applyProjectLinkGitignoreRules(file.content, file.scope === 'project' ? 'local' : 'nested');
        if (next !== file.content) {
            file.content = next;
            dirty.set(file.path, next);
        }
    }

    if (isProjectCovered(projectRoot, chain)) {
        return writeDirty(dirty, coveringGitignorePath(projectRoot, chain), dirty.size > 0 ? 'updated' : 'unchanged');
    }

    const target = pickTarget(projectRoot, chain);
    const mode: ProjectLinkGitignoreMode = target.scope === 'project' ? 'local' : 'nested';
    const existed = fs.existsSync(target.path) && fs.statSync(target.path).isFile();
    const next = applyProjectLinkGitignoreRules(target.content, mode);
    if (next !== target.content || !existed) {
        dirty.set(target.path, next);
    }

    if (dirty.size === 0) {
        return { kind: 'unchanged', path: target.path };
    }

    return writeDirty(dirty, target.path, existed ? 'updated' : 'created');
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

function writeDirty(
    dirty: Map<string, string>,
    resultPath: string,
    kind: 'created' | 'updated' | 'unchanged',
): ProjectLinkGitignoreResult {
    for (const [filePath, content] of dirty) {
        fs.writeFileSync(filePath, content, 'utf8');
    }
    return { kind, path: resultPath };
}

function pickTarget(projectRoot: string, chain: GitignoreFile[]): GitignoreFile {
    const projectFile = chain.find(file => file.scope === 'project');
    if (projectFile) {
        return projectFile;
    }
    if (chain.length > 0) {
        return chain[chain.length - 1];
    }
    return {
        path: getProjectLinkGitignorePath(projectRoot),
        content: '',
        scope: 'project',
    };
}

function coveringGitignorePath(projectRoot: string, chain: GitignoreFile[]): string {
    const projectFile = chain.find(file => file.scope === 'project');
    if (projectFile && hasLocalCoverage(projectFile.content)) {
        return projectFile.path;
    }
    const coveringAncestor = [...chain].reverse().find(file => fileCoversProject(projectRoot, file));
    return coveringAncestor?.path ?? getProjectLinkGitignorePath(projectRoot);
}

function isProjectCovered(projectRoot: string, chain: GitignoreFile[]): boolean {
    if (chain.some(file => hasDirectoryIgnore(file.content))) {
        return false;
    }
    return chain.some(file => fileCoversProject(projectRoot, file));
}

function fileCoversProject(projectRoot: string, file: GitignoreFile): boolean {
    if (file.scope === 'project') {
        return hasLocalCoverage(file.content);
    }
    if (hasNestedCoverage(file.content)) {
        return true;
    }
    const relativeProject = posixRelative(path.dirname(file.path), projectRoot);
    return hasPathSpecificCoverage(file.content, relativeProject);
}

function collectGitignoreChain(projectRoot: string, gitRoot: string): GitignoreFile[] {
    const files: GitignoreFile[] = [];
    let current = projectRoot;
    while (true) {
        const gitignorePath = path.join(current, PROJECT_LINK_GITIGNORE_RELATIVE_PATH);
        if (fs.existsSync(gitignorePath) && fs.statSync(gitignorePath).isFile()) {
            files.push({
                path: gitignorePath,
                content: fs.readFileSync(gitignorePath, 'utf8'),
                scope: current === projectRoot ? 'project' : 'ancestor',
            });
        }
        if (current === gitRoot) {
            return files;
        }
        const parent = path.dirname(current);
        if (parent === current) {
            return files;
        }
        current = parent;
    }
}

function findGitRoot(start: string): string | undefined {
    let current = start;
    while (true) {
        if (fs.existsSync(path.join(current, '.git'))) {
            return current;
        }
        const parent = path.dirname(current);
        if (parent === current) {
            return undefined;
        }
        current = parent;
    }
}

function createdGitignoreContents(mode: ProjectLinkGitignoreMode = 'local'): string {
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

function hasPathSpecificCoverage(content: string, projectRel: string): boolean {
    if (!projectRel || projectRel === '.' || projectRel.startsWith('../') || projectRel.startsWith('..')) {
        return false;
    }
    const ignoreRule = `${projectRel}/.vendure/*`;
    const ignoreRuleRecursive = `${projectRel}/.vendure/**`;
    const keepRule = `!${projectRel}/.vendure/project.json`;
    return hasRuleCoverage(
        content,
        pattern => pattern === ignoreRule || pattern === ignoreRuleRecursive || pattern === `/${ignoreRule}`,
        pattern => pattern === keepRule || pattern === `!/${projectRel}/.vendure/project.json`,
    );
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
        if (!pattern) {
            continue;
        }
        if (isIgnore(pattern)) {
            sawIgnoreContents = true;
        }
        if (isKeep(pattern)) {
            sawKeepManifest = true;
        }
    }
    return sawIgnoreContents && sawKeepManifest && !hasDirectoryIgnore(content);
}

function hasDirectoryIgnore(content: string): boolean {
    return content.split(/\r?\n/).some(line => {
        const pattern = ignorePattern(line);
        return pattern !== undefined && isDirectoryIgnore(pattern);
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
    if (content.length === 0 || content.endsWith('\n')) {
        return content;
    }
    return `${content}${newline}`;
}

function detectNewline(content: string): string {
    return content.includes('\r\n') ? '\r\n' : '\n';
}

function ignorePattern(line: string): string | undefined {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) {
        return undefined;
    }
    return trimmed;
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

function isDirectoryIgnore(pattern: string): boolean {
    if (pattern.startsWith('!')) {
        return false;
    }
    return /(?:^|\/)(?:\*\*\/)?\.vendure\/?$/.test(stripRootAnchor(pattern));
}

function stripRootAnchor(pattern: string): string {
    return pattern.startsWith('/') ? pattern.slice(1) : pattern;
}

function posixRelative(from: string, to: string): string {
    return path.relative(from, to).split(path.sep).join('/');
}
