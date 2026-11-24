import { randomUUID } from 'node:crypto';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
export const TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_REPORTS = 20;
const BYTE_LIMIT = 64 * 1024;
const version = z.string().max(48).regex(/^\d+\.\d+\.\d+(?:[-+][a-z0-9.-]+)?$/i);
const ordinal = z.number().int().min(0).max(127);
export const reportSchema = z.object({
    version: z.literal(1), kind: z.literal('automatic'),
    pluginVersion: version, hostVersion: version.nullable(),
    threshold: z.number().int().min(3).max(15),
    mode: z.enum(['observe', 'enforce']), count: z.number().int().positive(),
    action: z.enum(['observed', 'cut', 'resumed']),
    trace: z.object({ events: z.array(z.object({ kind: z.enum(['start', 'end', 'delta']), block: ordinal })).max(64), groups: z.array(ordinal).max(32) }),
});
const keySchema = z.object({ session: z.string().min(1).max(160), turn: z.number().int().nonnegative() });
const entriesSchema = z.array(z.object({ ...keySchema.shape, at: z.number().int().nonnegative(), report: reportSchema })).max(MAX_REPORTS);
export function createDiagnosticStore(profileDir, now = Date.now) {
    const dir = join(profileDir, 'dsh-fail-guard');
    const file = join(dir, 'diagnostics-v1.json');
    let pending = Promise.resolve();
    let depth = 0;
    function serial(op, fallback) {
        if (depth >= MAX_REPORTS)
            return Promise.resolve(fallback);
        depth++;
        const task = pending.then(op).catch(() => fallback).finally(() => { depth--; });
        pending = task.then(() => { });
        return task;
    }
    async function read() {
        try {
            const handle = await open(file, 'r');
            try {
                const data = Buffer.alloc(BYTE_LIMIT + 1);
                const { bytesRead } = await handle.read(data, 0, data.length, 0);
                if (bytesRead > BYTE_LIMIT)
                    return { entries: [], dirty: true };
                const parsed = entriesSchema.safeParse(JSON.parse(data.toString('utf8', 0, bytesRead)));
                if (!parsed.success)
                    return { entries: [], dirty: true };
                const clock = now();
                const entries = parsed.data.filter(entry => entry.at <= clock && clock - entry.at < TTL_MS);
                return { entries, dirty: entries.length !== parsed.data.length };
            }
            finally {
                await handle.close();
            }
        }
        catch (error) {
            if (error?.code === 'ENOENT')
                return { entries: [], dirty: false };
            if (error instanceof SyntaxError)
                return { entries: [], dirty: true };
            throw error;
        }
    }
    async function write(entries) {
        if (!entries.length) {
            await rm(file, { force: true });
            return;
        }
        await mkdir(dir, { recursive: true, mode: 0o700 });
        const data = JSON.stringify(entries);
        if (Buffer.byteLength(data) > BYTE_LIMIT)
            throw new Error('Diagnostic cache exceeds expected limit');
        const temp = join(dir, '.diagnostics-' + randomUUID());
        try {
            const h = await open(temp, 'wx', 0o600);
            try {
                await h.writeFile(data);
            }
            finally {
                await h.close();
            }
            await rename(temp, file);
        }
        finally {
            await rm(temp, { force: true }).catch(() => { });
        }
    }
    return {
        prune: () => serial(async () => { const r = await read(); if (r.dirty)
            await write(r.entries); }, undefined),
        put(session, turn, report) {
            const key = keySchema.safeParse({ session, turn });
            const validated = reportSchema.safeParse(report);
            if (!key.success || !validated.success)
                return Promise.resolve(false);
            return serial(async () => {
                const { entries } = await read();
                const match = entries.find(x => x.session === session && x.turn === turn);
                await write([...entries.filter(x => x !== match), { ...key.data, at: match?.at ?? now(), report: validated.data }].slice(-MAX_REPORTS));
                return true;
            }, false);
        },
        get(session, turn) {
            if (!keySchema.safeParse({ session, turn }).success)
                return Promise.resolve(null);
            return serial(async () => {
                const r = await read();
                if (r.dirty)
                    await write(r.entries);
                return r.entries.find(x => x.session === session && x.turn === turn)?.report ?? null;
            }, null);
        },
    };
}
