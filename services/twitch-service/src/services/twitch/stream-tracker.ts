export type StreamComputedStats = {
    peak: number;
    durationMs: number;
    followsCount: number;
};

export function computeStreamStats(input: {
    viewerCounts: number[];
    followsCount: number;
    startTimeMs: number;
    nowMs?: number;
}): StreamComputedStats {
    const counts = input.viewerCounts.filter((c) => typeof c === 'number' && !isNaN(c));
    const peak = counts.length > 0 ? Math.max(...counts) : 0;

    const durationMs = (input.nowMs ?? Date.now()) - input.startTimeMs;
    return { peak, durationMs, followsCount: input.followsCount };
}

export function formatDuration(durationMs: number): string {
    const hours = Math.floor(durationMs / 3600000);
    const minutes = Math.floor((durationMs % 3600000) / 60000);
    return hours > 0 ? `${hours}ч ${minutes}мин` : `${minutes}мин`;
}
