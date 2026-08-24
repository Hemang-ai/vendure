import fs from 'fs-extra';
import path from 'node:path';

export const PROJECT_LINK_GITIGNORE_RELATIVE_PATH = '.gitignore';
export const PROJECT_LINK_IGNORE_CONTENTS = '.vendure/*';
export const PROJECT_LINK_KEEP_MANIFEST = '!.vendure/project.json';
export const PROJECT_LINK_GITIGNORE_COMMENT =
    '# Commit the identity-only Project Link Manifest. Keep all other local Vendure state ignored.';

export type ProjectLinkGitignoreResult =
    | { kind: 'unchanged'; path: string }
    | { kind: 'created'; path: string }
    | { kind: 'updated'; path: string }
    | { kind: 'failed'; path: string; reason: string };

export function getProjectLinkGitignorePath(projectRoot: string): string {
    return path.join(projectRoot, PROJECT_LINK_GITIGNORE_RELATIVE_PATH);
}

export function ensureProjectLinkGitignore(projectRoot: string): ProjectLinkGitignoreResult {
    const gitignorePath = getProjectLinkGitignorePath(projectRoot);
    try {
        if (!fs.existsSync(gitignorePath)) {
            fs.writeFileSync(gitignorePath, createdGitignoreContents(), 'utf8');
            return { kind: 'created', path: gitignorePath };
        }

        const raw = fs.readFileSync(gitignorePath, 'utf8');
        const next = applyProjectLinkGitignoreRules(raw);
        if (next === raw) {
            return { kind: 'unchanged', path: gitignorePath };
        }

        fs.writeFileSync(gitignorePath, next, 'utf8');
        return { kind: 'updated', path: gitignorePath };
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return { kind: 'failed', path: gitignorePath, reason };
    }
}

export function applyProjectLinkGitignoreRules(content: string): string {
    if (hasRequiredProjectLinkGitignoreRules(content)) {
        return content;
    }

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
        if (isIgnoreContents(pattern)) {
            sawIgnoreContents = true;
            return line;
        }
        if (isKeepManifest(pattern)) {
            sawKeepManifest = true;
            return line;
        }
        if (isDirectoryIgnore(pattern)) {
            changed = true;
            sawIgnoreContents = true;
            return PROJECT_LINK_IGNORE_CONTENTS;
        }
        return line;
    });

    const missing: string[] = [];
    if (!sawIgnoreContents) {
        missing.push(PROJECT_LINK_IGNORE_CONTENTS);
    }
    if (!sawKeepManifest) {
        missing.push(PROJECT_LINK_KEEP_MANIFEST);
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

function createdGitignoreContents(): string {
    return `${[PROJECT_LINK_GITIGNORE_COMMENT, PROJECT_LINK_IGNORE_CONTENTS, PROJECT_LINK_KEEP_MANIFEST].join(
        '\n',
    )}\n`;
}

function hasRequiredProjectLinkGitignoreRules(content: string): boolean {
    let sawIgnoreContents = false;
    let sawKeepManifest = false;
    for (const line of content.split(/\r?\n/)) {
        const pattern = ignorePattern(line);
        if (!pattern) {
            continue;
        }
        if (isIgnoreContents(pattern)) {
            sawIgnoreContents = true;
        }
        if (isKeepManifest(pattern)) {
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

function isIgnoreContents(pattern: string): boolean {
    return /^(?:\*\*\/)?\.vendure\/\*\*?$/.test(stripRootAnchor(pattern));
}

function isKeepManifest(pattern: string): boolean {
    return /^!(?:\*\*\/)?\.vendure\/project\.json$/.test(pattern.replace(/^!\/(?=\.)/, '!'));
}

function isDirectoryIgnore(pattern: string): boolean {
    if (pattern.startsWith('!')) {
        return false;
    }
    return /^(?:\*\*\/)?\.vendure\/?$/.test(stripRootAnchor(pattern));
}

function stripRootAnchor(pattern: string): string {
    return pattern.startsWith('/') ? pattern.slice(1) : pattern;
}
