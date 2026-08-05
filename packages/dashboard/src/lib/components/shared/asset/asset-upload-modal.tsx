import { Button } from '@/vdb/components/ui/button.js';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/vdb/components/ui/dialog.js';
import { Progress } from '@/vdb/components/ui/progress.js';
import { LS_KEY_SELECTED_CHANNEL_TOKEN, LS_KEY_SESSION_TOKEN, LS_KEY_USER_SETTINGS } from '@/vdb/constants.js';
import { getApiBaseUrl } from '@/vdb/utils/config-utils.js';
import { Trans } from '@lingui/react/macro';
import { print } from 'graphql';
import { CheckCircle2, Clock, Loader2, XCircle } from 'lucide-react';
import { useEffect, useState } from 'react';
import { uiConfig } from 'virtual:vendure-ui-config';
import { createAssetsDocument } from './asset-gallery.js';

// ─── Types ────────────────────────────────────────────────────────────────────

type UploadStatus = 'queued' | 'uploading' | 'done' | 'error';

interface FileUpload {
    file: File;
    status: UploadStatus;
    progress: number; // 0–100
    error?: string;
}

type UploadResult = { success: true } | { success: false; error: string };

// ─── Pure helpers ─────────────────────────────────────────────────────────────

function isTerminalStatus(upload: FileUpload): boolean {
    return upload.status === 'done' || upload.status === 'error';
}

function allUploadsFinished(uploads: FileUpload[]): boolean {
    return uploads.length > 0 && uploads.every(isTerminalStatus);
}

function overallProgress(uploads: FileUpload[]): number {
    if (uploads.length === 0) return 0;
    const total = uploads.reduce((sum, upload) => sum + upload.progress, 0);
    return Math.round(total / uploads.length);
}

function withUpdatedUpload(
    uploads: FileUpload[],
    index: number,
    patch: Partial<FileUpload>,
): FileUpload[] {
    return uploads.map((upload, i) => (i === index ? { ...upload, ...patch } : upload));
}

// ─── XHR upload ───────────────────────────────────────────────────────────────

// XHR is used instead of fetch because fetch has no upload.onprogress event.
// Each file is sent as its own request so we get 0-100% progress per file.

function buildApiUrl(): string {
    let url = `${getApiBaseUrl()}/${uiConfig.api.adminApiPath}`;
    try {
        const settings = JSON.parse(localStorage.getItem(LS_KEY_USER_SETTINGS) ?? '{}');
        if (settings.contentLanguage) {
            url += `?languageCode=${settings.contentLanguage}`;
        }
    } catch {}
    return url;
}

function applyAuthHeaders(xhr: XMLHttpRequest): void {
    const sessionToken = localStorage.getItem(LS_KEY_SESSION_TOKEN);
    const channelToken = localStorage.getItem(LS_KEY_SELECTED_CHANNEL_TOKEN);
    if (sessionToken) xhr.setRequestHeader('Authorization', `Bearer ${sessionToken}`);
    if (channelToken) xhr.setRequestHeader(uiConfig.api.channelTokenKey, channelToken);
}

function buildMultipartBody(file: File): FormData {
    const body = new FormData();
    body.append(
        'operations',
        JSON.stringify({ query: print(createAssetsDocument), variables: { input: [{ file: null }] } }),
    );
    body.append('map', JSON.stringify({ '0': ['variables.input.0.file'] }));
    body.append('0', file, file.name);
    return body;
}

function parseGraphqlResponse(responseText: string): UploadResult {
    try {
        const json = JSON.parse(responseText);
        const graphqlError = json?.errors?.[0]?.message;
        if (graphqlError) return { success: false, error: graphqlError };
    } catch {}
    return { success: true };
}

function parseServerResponse(xhr: XMLHttpRequest): UploadResult {
    if (xhr.status === 413) return { success: false, error: 'File exceeds the server upload size limit' };
    if (xhr.status < 200 || xhr.status >= 300) return { success: false, error: `Upload failed (HTTP ${xhr.status})` };
    return parseGraphqlResponse(xhr.responseText);
}

function sendUploadRequest(
    file: File,
    onProgress: (percent: number) => void,
): Promise<UploadResult> {
    return new Promise(resolve => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', buildApiUrl());
        applyAuthHeaders(xhr);

        xhr.upload.onprogress = e => {
            if (e.lengthComputable) {
                onProgress(Math.round((e.loaded / e.total) * 100));
            }
        };

        xhr.onload = () => resolve(parseServerResponse(xhr));
        xhr.onerror = () => resolve({ success: false, error: 'Upload failed — check your connection' });

        xhr.send(buildMultipartBody(file));
    });
}

// ─── Component ────────────────────────────────────────────────────────────────

export interface AssetUploadModalProps {
    files: File[];
    open: boolean;
    onClose: () => void;
    onComplete: () => void;
}

export function AssetUploadModal({ files, open, onClose, onComplete }: AssetUploadModalProps) {
    const [fileUploads, setFileUploads] = useState<FileUpload[]>([]);

    useEffect(() => {
        if (!open || !files.length) return;

        const initialUploads: FileUpload[] = files.map(file => ({
            file,
            status: 'queued',
            progress: 0,
        }));
        setFileUploads(initialUploads);

        let active = true;

        async function uploadSingleFile(fileUpload: FileUpload, index: number): Promise<void> {
            setFileUploads(prev => withUpdatedUpload(prev, index, { status: 'uploading' }));

            const result = await sendUploadRequest(fileUpload.file, percent => {
                if (active) setFileUploads(prev => withUpdatedUpload(prev, index, { progress: percent }));
            });

            if (!active) return;

            if (result.success) {
                setFileUploads(prev => withUpdatedUpload(prev, index, { status: 'done', progress: 100 }));
            } else {
                setFileUploads(prev => withUpdatedUpload(prev, index, { status: 'error', error: result.error }));
            }
        }

        async function uploadAll(): Promise<void> {
            await Promise.all(initialUploads.map((upload, index) => uploadSingleFile(upload, index)));
            if (active) onComplete();
        }

        uploadAll();

        return () => {
            active = false;
        };
    }, [open, files]);

    const doneCount = fileUploads.filter(u => u.status === 'done').length;

    return (
        <Dialog open={open} onOpenChange={isOpen => { if (!isOpen && allUploadsFinished(fileUploads)) onClose(); }}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>
                        <Trans>Uploading assets</Trans>
                    </DialogTitle>
                    <DialogDescription className="sr-only">
                        <Trans>Upload progress for {fileUploads.length} files</Trans>
                    </DialogDescription>
                </DialogHeader>

                <div className="space-y-1">
                    <div className="flex justify-between text-sm text-muted-foreground">
                        <span>
                            <Trans>{doneCount} of {fileUploads.length} done</Trans>
                        </span>
                        <span>{overallProgress(fileUploads)}%</span>
                    </div>
                    <Progress value={overallProgress(fileUploads)} />
                </div>

                <div className="space-y-3 max-h-72 overflow-y-auto">
                    {fileUploads.map((upload, index) => (
                        <div key={index} className="space-y-1">
                            <div className="flex items-center gap-2 text-sm">
                                <UploadStatusIcon status={upload.status} />
                                <span className="flex-1 truncate">{upload.file.name}</span>
                                <span className="text-muted-foreground shrink-0">{upload.progress}%</span>
                            </div>
                            <Progress value={upload.progress} />
                            {upload.error && <p className="text-xs text-destructive">{upload.error}</p>}
                        </div>
                    ))}
                </div>

                <DialogFooter>
                    <Button onClick={onClose} disabled={!allUploadsFinished(fileUploads)}>
                        {allUploadsFinished(fileUploads) ? <Trans>Close</Trans> : <Trans>Uploading...</Trans>}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

function UploadStatusIcon({ status }: { status: UploadStatus }) {
    switch (status) {
        case 'queued':    return <Clock        className="h-4 w-4 text-muted-foreground shrink-0" />;
        case 'uploading': return <Loader2      className="h-4 w-4 animate-spin text-primary shrink-0" />;
        case 'done':      return <CheckCircle2 className="h-4 w-4 text-success shrink-0" />;
        case 'error':     return <XCircle      className="h-4 w-4 text-destructive shrink-0" />;
    }
}
