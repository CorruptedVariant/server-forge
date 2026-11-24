// Long-running background tasks (installing or updating a server) with progress, streamed live to the UI.
import { randomUUID } from 'node:crypto';
import { events } from './events.ts';

export type JobKind = 'install' | 'update' | 'backup' | 'restore';

export interface JobInfo {
  id: string;
  serverId: string;
  kind: JobKind;
  title: string;
  status: 'running' | 'done' | 'failed';
  /** 0-100, or null when unknown. */
  progress: number | null;
  /** What is happening right now, in plain words. */
  step: string;
  error: string | null;
  startedAt: number;
  finishedAt: number | null;
}

export interface Job {
  info: JobInfo;
  /** Update the step text and/or progress. */
  update(step: string, progress?: number | null): void;
  /** A raw output line (shown in the server's console). */
  line(text: string): void;
}

const jobs = new Map<string, JobInfo>();

export function jobsFor(serverId: string): JobInfo[] {
  return [...jobs.values()].filter((j) => j.serverId === serverId);
}

export function runningJob(serverId: string): JobInfo | null {
  return jobsFor(serverId).find((j) => j.status === 'running') ?? null;
}

/**
 * Runs `work` as a job for a server. Only one job per server at a time.
 * `onLine` receives output lines (the server instance adds them to its console so they're kept, not just streamed).
 */
export function startJob(serverId: string, title: string, work: (job: Job) => Promise<void>, onLine?: (text: string) => void, kind: JobKind = 'install'): JobInfo {
  const busy = runningJob(serverId);
  if (busy) throw new Error(`Wait for "${busy.title}" to finish first.`);
  // Keep only the latest finished job per server.
  for (const [id, j] of jobs) if (j.serverId === serverId && j.status !== 'running') jobs.delete(id);

  const info: JobInfo = { id: randomUUID(), serverId, kind, title, status: 'running', progress: null, step: 'Starting…', error: null, startedAt: Date.now(), finishedAt: null };
  jobs.set(info.id, info);
  let lastEmit = 0;
  const emit = (force = false) => {
    // Progress can update many times a second; the UI only needs a few updates per second.
    if (!force && Date.now() - lastEmit < 250) return;
    lastEmit = Date.now();
    events.emit('job', { ...info });
    events.emit('state', serverId);
  };
  const job: Job = {
    info,
    update(step, progress) {
      info.step = step;
      if (progress !== undefined) info.progress = progress;
      emit();
    },
    line(text) {
      const tagged = `[${kind === 'update' ? 'install' : kind}] ${text}`;
      if (onLine) onLine(tagged);
      else events.emit('line', serverId, tagged);
    },
  };

  emit(true);
  work(job)
    .then(() => {
      info.status = 'done';
      info.progress = 100;
      info.step = 'Finished.';
    })
    .catch((err: Error) => {
      info.status = 'failed';
      info.error = err.message;
      info.step = 'Failed.';
      job.line(`Failed: ${err.message}`);
    })
    .finally(() => {
      info.finishedAt = Date.now();
      emit(true);
    });
  return info;
}
