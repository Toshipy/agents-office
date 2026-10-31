import { describe, expect, it } from 'vitest';
import { buildProjectStats, buildSeats, aggregateAgentStatus, type ProjectionInput } from './index';

const now = new Date('2026-10-31T10:00:00Z');
const ago = (ms: number) => new Date(now.getTime() - ms);

function base(): ProjectionInput {
  return {
    now,
    workspaceId: 'ws_a',
    projects: [{ id: 'prj_1' }, { id: 'prj_2' }],
    agents: [
      { id: 'agt_p', role: 'planner', name: 'Sora', version: 1 },
      { id: 'agt_d', role: 'developer', name: 'Ren', version: 1 },
      { id: 'agt_t', role: 'tester', name: 'Mio', version: 1 },
      { id: 'agt_r', role: 'reviewer', name: 'Kei', version: 1 },
    ],
    runs: [],
    steps: [],
    approvals: [],
  };
}

describe('buildSeats', () => {
  it('creates one seat per project × role, all idle without runs', () => {
    const seats = buildSeats(base());
    expect(seats).toHaveLength(8);
    expect(seats.every((s) => s.status === 'idle')).toBe(true);
  });

  it('marks running step as working / reviewing only on the matching project seat', () => {
    const input = base();
    input.runs.push({
      id: 'run_1', projectId: 'prj_1', title: 'Login', status: 'running', prNumber: null,
      createdAt: ago(60_000), updatedAt: ago(1000), finishedAt: null,
    });
    input.steps.push(
      { id: 'stp_1', runId: 'run_1', projectId: 'prj_1', role: 'developer', key: 'implement', status: 'running', startedAt: ago(5000), finishedAt: null },
      { id: 'stp_2', runId: 'run_1', projectId: 'prj_1', role: 'reviewer', key: 'review', status: 'running', startedAt: ago(1000), finishedAt: null },
    );
    const seats = buildSeats(input);
    const dev1 = seats.find((s) => s.key === 'prj_1:developer')!;
    const dev2 = seats.find((s) => s.key === 'prj_2:developer')!;
    const rev1 = seats.find((s) => s.key === 'prj_1:reviewer')!;
    expect(dev1.status).toBe('working');
    expect(dev1.currentRun?.id).toBe('run_1');
    expect(dev1.activeRunIds).toEqual(['run_1']);
    expect(dev2.status).toBe('idle');
    expect(rev1.status).toBe('reviewing');
  });

  it('working takes priority over waiting_approval and failures', () => {
    const input = base();
    input.runs.push(
      { id: 'run_1', projectId: 'prj_1', title: 'A', status: 'running', prNumber: null, createdAt: ago(1), updatedAt: ago(1), finishedAt: null },
      { id: 'run_2', projectId: 'prj_1', title: 'B', status: 'needs_input', prNumber: null, createdAt: ago(1), updatedAt: ago(1), finishedAt: null },
    );
    input.steps.push(
      { id: 'stp_1', runId: 'run_1', projectId: 'prj_1', role: 'planner', key: 'plan', status: 'running', startedAt: ago(10), finishedAt: null },
    );
    input.approvals.push({ id: 'apr_1', runId: 'run_2', projectId: 'prj_1', actionType: 'clarification', requestedByRole: 'planner', createdAt: ago(100) });
    const planner = buildSeats(input).find((s) => s.key === 'prj_1:planner')!;
    expect(planner.status).toBe('working');
    expect(planner.activeRunIds.sort()).toEqual(['run_1', 'run_2']);
  });

  it('shows waiting_approval for pending approval on requesting role', () => {
    const input = base();
    input.runs.push({ id: 'run_1', projectId: 'prj_2', title: 'A', status: 'waiting_review', prNumber: 12, createdAt: ago(1), updatedAt: ago(1), finishedAt: null });
    input.approvals.push({ id: 'apr_1', runId: 'run_1', projectId: 'prj_2', actionType: 'pr_review', requestedByRole: 'reviewer', createdAt: ago(100) });
    const seat = buildSeats(input).find((s) => s.key === 'prj_2:reviewer')!;
    expect(seat.status).toBe('waiting_approval');
    expect(seat.statusReason).toContain('#12');
  });

  it('completed / failed decay over time', () => {
    const input = base();
    input.runs.push({ id: 'run_1', projectId: 'prj_1', title: 'A', status: 'running', prNumber: null, createdAt: ago(1), updatedAt: ago(1), finishedAt: null });
    input.steps.push(
      { id: 'stp_1', runId: 'run_1', projectId: 'prj_1', role: 'planner', key: 'plan', status: 'succeeded', startedAt: ago(70_000), finishedAt: ago(60_000) },
      { id: 'stp_2', runId: 'run_1', projectId: 'prj_1', role: 'tester', key: 'test', status: 'failed', startedAt: ago(70_000), finishedAt: ago(60_000) },
      { id: 'stp_3', runId: 'run_1', projectId: 'prj_2', role: 'planner', key: 'plan', status: 'succeeded', startedAt: ago(200_000), finishedAt: ago(100_000) },
    );
    const seats = buildSeats(input);
    expect(seats.find((s) => s.key === 'prj_1:planner')!.status).toBe('completed');
    expect(seats.find((s) => s.key === 'prj_1:tester')!.status).toBe('failed');
    expect(seats.find((s) => s.key === 'prj_2:planner')!.status).toBe('idle');
  });
});

describe('buildProjectStats', () => {
  it('counts doing / next / done / waiting', () => {
    const input = base();
    input.runs.push(
      { id: 'r1', projectId: 'prj_1', title: '', status: 'running', prNumber: null, createdAt: ago(1), updatedAt: ago(1), finishedAt: null },
      { id: 'r2', projectId: 'prj_1', title: '', status: 'queued', prNumber: null, createdAt: ago(1), updatedAt: ago(1), finishedAt: null },
      { id: 'r3', projectId: 'prj_1', title: '', status: 'completed', prNumber: null, createdAt: ago(1), updatedAt: ago(1), finishedAt: ago(1000) },
      { id: 'r4', projectId: 'prj_1', title: '', status: 'completed', prNumber: null, createdAt: ago(1), updatedAt: ago(1), finishedAt: ago(2 * 24 * 3600_000) },
      { id: 'r5', projectId: 'prj_1', title: '', status: 'waiting_review', prNumber: 3, createdAt: ago(1), updatedAt: ago(1), finishedAt: null },
      { id: 'r6', projectId: 'prj_2', title: '', status: 'running', prNumber: null, createdAt: ago(1), updatedAt: ago(1), finishedAt: null },
    );
    input.approvals.push({ id: 'a1', runId: 'r5', projectId: 'prj_1', actionType: 'pr_review', requestedByRole: 'reviewer', createdAt: ago(1) });
    expect(buildProjectStats(input, 'prj_1')).toEqual({
      doing: 1, next: 1, done24h: 1, failed24h: 0, waitingApproval: 1, openPrs: 1,
    });
  });
});

describe('aggregateAgentStatus', () => {
  it('picks highest priority status across projects', () => {
    const input = base();
    input.runs.push({ id: 'run_1', projectId: 'prj_2', title: 'A', status: 'running', prNumber: null, createdAt: ago(1), updatedAt: ago(1), finishedAt: null });
    input.steps.push({ id: 'stp_1', runId: 'run_1', projectId: 'prj_2', role: 'developer', key: 'implement', status: 'running', startedAt: ago(10), finishedAt: null });
    const agg = aggregateAgentStatus(buildSeats(input));
    expect(agg.get('agt_d')).toBe('working');
    expect(agg.get('agt_p')).toBe('idle');
  });
});
